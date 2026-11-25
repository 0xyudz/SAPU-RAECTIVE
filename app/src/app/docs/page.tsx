import Link from "next/link";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { DOC_PAGES } from "@/config/docs-content";

export const metadata = {
  title: "Docs — SAPU",
  description: "Specification, security model, and limitations for the SAPU reactive purge loop.",
};

export default function DocsIndexPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-14">
        <p className="label-caps">Documentation</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-50">SAPU specification</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-slate-400">
          How the loop works, what secures it, and — just as importantly — what it does not do.
        </p>

        <div className="mt-9 space-y-3">
          {DOC_PAGES.map((page) => (
            <Link
              key={page.slug}
              href={`/docs/${page.slug}`}
              className="panel group block p-5 transition-colors hover:border-steel-bright"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-mono text-sm font-semibold text-slate-100 group-hover:text-lime-glow">
                  {page.title}
                </h2>
                <span className="font-mono text-[10px] text-slate-600 transition-transform group-hover:translate-x-0.5">
                  →
                </span>
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">{page.summary}</p>
            </Link>
          ))}
        </div>

        <div className="panel mt-9 p-5">
          <h2 className="font-mono text-sm font-semibold text-slate-100">Repository documents</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-500">
            The canonical specs live in the repository and are the source of truth for reviewers.
          </p>
          <ul className="mt-3 space-y-1.5 font-mono text-[12px]">
            {[
              ["SPEC-REACTIVE-LOOP.md", "exact topic hashes, criteria, gas budgets, proof methodology"],
              ["REACTIVE-IMPLEMENTATION.md", "each module mapped to the official Reactive rule it implements"],
              ["INTEGRATIONS.md", "chain ids, system contract, callback proxies, faucets"],
              ["DECISIONS.md", "why each constraint exists, and the failure behind it"],
              ["JUDGING.md", "how each requirement maps to a concrete artefact"],
              ["LIMITATIONS.md", "permit vs allowance tradeoffs and failure modes"],
            ].map(([file, note]) => (
              <li key={file} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <span className="shrink-0 text-lime-dim">docs/{file}</span>
                <span className="text-slate-600">{note}</span>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
