import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome. Deliberately quiet: the product is about things *not* being
 * observable, so the interface avoids visual noise.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-steel/80 bg-void/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
        <Link href="/" className="group flex items-center gap-2.5">
          <BroomMark />
          <span className="font-mono text-sm font-semibold tracking-[0.22em] text-slate-100 group-hover:text-lime-glow">
            SAPU
          </span>
        </Link>

        <nav className="flex items-center gap-1 font-mono text-xs">
          <NavLink href="/app">Console</NavLink>
          <NavLink href="/docs">Docs</NavLink>
          <a
            href="https://dev.reactive.network"
            target="_blank"
            rel="noreferrer"
            className="rounded px-3 py-1.5 text-slate-500 transition-colors hover:text-slate-300"
          >
            Reactive ↗
          </a>
        </nav>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded px-3 py-1.5 text-slate-400 transition-colors hover:bg-steel/60 hover:text-lime-glow"
    >
      {children}
    </Link>
  );
}

/** A broom: the literal meaning of "sapu". Drawn as a purge sweep. */
export function BroomMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M15.5 3.5 11 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-steel-bright" />
      <path d="M11.6 7.4 8.9 10.1" stroke="#84CC16" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M9.2 9.8 4.6 14.4c-.5.5-.6 1.2-.2 1.8l1.1 1.6c.4.6 1.2.7 1.8.3l5.2-3.6"
        stroke="#84CC16"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M6.4 13.6 3.2 19.4M8.6 14.6 6 20.2M10.6 15.4 9 20.6" stroke="#4D7C0F" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-steel/60">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-8 font-mono text-[11px] text-slate-600 sm:flex-row sm:items-center sm:justify-between">
        <p>
          SAPU · Silent Automated Purge Unit · <span className="text-slate-500">sapu</span> is Indonesian for broom
        </p>
        <p className="text-slate-600">
          Base Sepolia <span className="text-steel-bright">84532</span> → Reactive Lasna{" "}
          <span className="text-steel-bright">5318007</span>
        </p>
      </div>
    </footer>
  );
}
