#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { VIEWS } from "../app/src/config/views";
import { CHAINS } from "../app/src/config/chains";
import { explorerFor } from "./lib/explorers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const APP_SRC = path.join(REPO_ROOT, "app", "src");

function walkTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

/**
 * A test file is not an import site.
 *
 * Counting test imports as usage is how this gate missed real dead code: `shouldDisarm`,
 * `watchBurner` and `getLogsChunked` were all "used" only by their own tests, so the gate
 * reported zero dead exports while production never called them. Tests are evidence that
 * a function behaves, not evidence that anything ships it.
 */
function isTestFile(normFile: string): boolean {
  return normFile.includes("/__tests__/") || /\.test\.tsx?$/.test(normFile);
}

function resolveImport(fromFile: string, specifier: string): string | null {
  let candidate: string;
  if (specifier.startsWith("@/")) {
    candidate = path.join(APP_SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidate = path.resolve(path.dirname(fromFile), specifier);
  } else {
    return null;
  }

  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const full = candidate + ext;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return normalizePath(full);
    }
  }
  return normalizePath(candidate);
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function collectExports(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!hasExportModifier(stmt) && !ts.isExportDeclaration(stmt)) continue;

    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)) &&
      stmt.name
    ) {
      names.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          names.push(decl.name.text);
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        names.push(spec.name.text);
      }
    }
  }
  return names;
}

function collectIdentifierCounts(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return counts;
}

function main(): void {
  const failures: string[] = [];

  for (const view of VIEWS) {
    const relHref = view.href.replace(/^\//, "");
    const routeFile = path.join(APP_SRC, "app", relHref, "page.tsx");
    if (!fs.existsSync(routeFile)) {
      failures.push(`[VIEWS] "${view.id}" (${view.href}) has no route file at ${path.relative(REPO_ROOT, routeFile)}`);
    }
  }

  const allFiles = walkTsFiles(APP_SRC);
  const parsed = new Map<string, { text: string; sf: ts.SourceFile }>();
  for (const file of allFiles) {
    const text = fs.readFileSync(file, "utf8");
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    parsed.set(normalizePath(file), {
      text,
      sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind),
    });
  }

  const appDir = normalizePath(path.join(APP_SRC, "application"));
  const domainDir = normalizePath(path.join(APP_SRC, "domain"));
  const configDir = normalizePath(path.join(APP_SRC, "config"));
  const infraDirForDeadCode = normalizePath(path.join(APP_SRC, "infrastructure"));
  const componentsDirForDeadCode = normalizePath(path.join(APP_SRC, "components"));
  // components/ used to be excluded from the dead-export scan, and that blind spot is exactly
  // how a whole unreferenced UI card (`QrDepositCard`) survived with a green gate. A component
  // nobody renders is not shipped, no matter how well it is tested.
  const deadExportScopes = [appDir, domainDir, configDir, infraDirForDeadCode, componentsDirForDeadCode];

  const importedSymbols = new Map<string, Set<string>>();
  for (const [normFile] of parsed) {
    if (deadExportScopes.some((scope) => normFile.startsWith(scope + "/"))) {
      importedSymbols.set(normFile, new Set());
    }
  }

  const componentsDir = normalizePath(path.join(APP_SRC, "components"));
  const infraDir = normalizePath(path.join(APP_SRC, "infrastructure"));
  const abisFile = normalizePath(path.join(APP_SRC, "config", "abis.ts"));

  // Contract addresses belong in config/, where they are named, documented and reviewed.
  // A literal pasted into a component or an infrastructure module is how a stale deployment
  // address survives a redeploy unnoticed. Test files and config/ are out of scope: test data
  // is fake by definition, and config/ is where the real constants live.
  const addressAllowlistPrefix = normalizePath(path.join(APP_SRC, "config"));
  const sentinelAddresses = new Set([
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
  ]);

  let setArmedHits = 0;
  let writeContractHits = 0;
  let registrationImports = 0;
  let strayAddresses = 0;

  for (const [normFile, { text, sf }] of parsed) {
    if (!normFile.startsWith(addressAllowlistPrefix + "/") && !isTestFile(normFile)) {
      for (const match of text.matchAll(/0x[0-9a-fA-F]{40}\b/g)) {
        if (sentinelAddresses.has(match[0].toLowerCase())) continue;
        strayAddresses += 1;
        failures.push(
          `[HARDCODE] ${path.relative(REPO_ROOT, normFile)} embeds contract address ${match[0]}; declare it in config/ instead`,
        );
      }
    }

    // Test files may reference a module, but that does not make it part of the shipped
    // surface. Their imports are deliberately not recorded as import sites.
    const recordImports = !isTestFile(normFile);

    if (/\bsetArmed\b/.test(text)) {
      setArmedHits += 1;
      failures.push(`[ANTI-MOCK] Found forbidden "setArmed" in ${path.relative(REPO_ROOT, normFile)}`);
    }
    const wcMatches = text.match(/\bwriteContract\s*\(/g);
    if (wcMatches) {
      writeContractHits += wcMatches.length;
    }

    const namespaceAliases = new Map<string, string>();

    const checkSpecifier = (specifier: string) => {
      const target = resolveImport(normFile, specifier);
      if (target === null) return;

      if (normFile.startsWith(componentsDir + "/")) {
        if (target.startsWith(infraDir + "/") || target === infraDir || target === abisFile) {
          failures.push(
            `[LAYER] Component ${path.relative(REPO_ROOT, normFile)} imports forbidden module "${specifier}"`,
          );
        }
      }

      if (target.endsWith("/application/registration-service.ts")) {
        registrationImports += 1;
      }

      return target;
    };

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      const specifier = stmt.moduleSpecifier.text;
      const target = checkSpecifier(specifier);
      if (!target || target === normFile || !importedSymbols.has(target)) continue;

      const bucket = importedSymbols.get(target)!;
      const clause = stmt.importClause;
      if (!clause) continue;

      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (!recordImports) continue;
            bucket.add((el.propertyName ?? el.name).text);
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          namespaceAliases.set(clause.namedBindings.name.text, target);
        }
      }
    }

    if (normFile.startsWith(componentsDir + "/")) {
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.arguments.length >= 1) {
          const first = node.arguments[0]!;
          if (ts.isStringLiteral(first)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
              checkSpecifier(first.text);
            } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
              checkSpecifier(first.text);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    if (namespaceAliases.size > 0) {
      const visitNs = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
          const target = namespaceAliases.get(node.expression.text);
          if (target) importedSymbols.get(target)?.add(node.name.text);
        }
        ts.forEachChild(node, visitNs);
      };
      visitNs(sf);
    }
  }

  let writeUseCaseCount = 0;

  for (const [normFile, { text, sf }] of parsed) {
    if (deadExportScopes.some((scope) => normFile.startsWith(scope + "/"))) {
      const exports = collectExports(sf);
      const used = importedSymbols.get(normFile) ?? new Set<string>();
      const internalCounts = collectIdentifierCounts(sf);
      for (const name of exports) {
        if (used.has(name)) continue;
        if ((internalCounts.get(name) ?? 0) > 1) continue;
        failures.push(
          `[DEAD-EXPORT] ${path.relative(REPO_ROOT, normFile)} exports "${name}" with no import site and no internal reference`,
        );
      }
    }

    if (!normFile.startsWith(appDir + "/")) continue;

    const isWriteUseCase = /\.send\s*\(/.test(text);
    if (isWriteUseCase) {
      writeUseCaseCount += 1;
      if (!/\.simulateContract\s*\(/.test(text)) {
        failures.push(
          `[PROTOCOL] Write use case ${path.relative(REPO_ROOT, normFile)} has no simulateContract() call`,
        );
      }
    }
  }

  if (writeContractHits !== writeUseCaseCount) {
    failures.push(
      `[PROTOCOL] Found ${writeContractHits} writeContract() call(s) in app/src, expected ${writeUseCaseCount} (1 per write use case)`,
    );
  }

  if (registrationImports < 2) {
    failures.push(
      `[ACCEPTANCE] Expected registration-service to be imported by at least page + test, found ${registrationImports} import site(s)`,
    );
  }

  if (setArmedHits > 0) {
    failures.push(`[ANTI-MOCK] Found ${setArmedHits} setArmed reference(s)`);
  }

  if (strayAddresses > 0) {
    failures.push(`[HARDCODE] Found ${strayAddresses} contract address literal(s) outside config/`);
  }

  // `scripts/lib/explorers.ts` duplicates the explorer URLs from `config/chains.ts` because
  // scripts cannot resolve the app's `@/` alias. Duplication drifts, and a drifted explorer
  // link is a fabricated chain fact: it claims a transaction exists on a chain it was never
  // sent to. Cross-checking here means the copy cannot silently diverge.
  for (const chain of CHAINS) {
    const scriptSide = explorerFor(chain.id);
    const appSide = chain.explorerUrl.replace(/\/$/, "");
    if (scriptSide !== appSide) {
      failures.push(
        `[CHAIN-TABLE] scripts/lib/explorers.ts has ${scriptSide ?? "no entry"} for ${chain.name} (${chain.id}) but app/src/config/chains.ts has ${appSide}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("SAPU surface audit FAILED:\n");
    for (const item of failures) {
      console.error(`  ✗ ${item}`);
    }
    process.exit(1);
  }

  console.log("SAPU surface audit PASSED:");
  console.log(`  ✓ ${VIEWS.length} views in config/views.ts all have matching route files`);
  console.log(`  ✓ 0 dead exports across app/src/{application,domain,config,infrastructure,components}`);
  console.log(`  ✓ 0 forbidden infrastructure/ or config/abis imports in app/src/components/`);
  console.log(`  ✓ ${CHAINS.length} chains: app/src/config/chains.ts and scripts/lib/explorers.ts agree`);
  console.log(`  ✓ 0 undeclared contract addresses in app/src outside config/`);
  console.log(`  ✓ ${writeUseCaseCount}/${writeUseCaseCount} write use cases call simulateContract() (${writeContractHits} writeContract sites)`);
  console.log(`  ✓ 0 setArmed references; registration-service has ${registrationImports} import sites`);
}

main();
