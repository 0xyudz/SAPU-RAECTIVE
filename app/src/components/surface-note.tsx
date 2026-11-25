"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { VIEWS } from "@/config/views";

/**
 * The bridge between the landing page and the operator surface.
 *
 * The landing page sells a product to someone who wants to hide the funding link on a
 * burner. `/app` then hands that same person a console built for whoever runs the
 * deployment: route inventory, owner-only repairs, gas budgets. Nothing in between said
 * so, and the honest failure was not confusion about any single term — it was that a
 * visitor had no idea whether they were looking at a product or at its evidence.
 *
 * The wording depends on the page, because the pages do different things. Three of them
 * are read-only and need no key; Arm a route signs transactions and needs two different
 * owners. A single banner claiming "read-only, no key required" above a page that asks for
 * a signature would be exactly the comfortable lie this app refuses to tell elsewhere.
 */
export function SurfaceNote() {
  const pathname = usePathname();
  const activeView = VIEWS.find((view) => view.href === pathname);
  const signs = activeView?.audience === "operator";
  const readOnlyViews = VIEWS.filter((view) => view.audience === "public");

  return (
    <section className="panel border-l-2 border-l-lime-dim px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-wider text-lime-dim">
        {signs ? "This page signs transactions" : "You are on the evidence surface"}
      </p>

      {signs ? (
        <>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-300">
            Arming a route is owner-only, and it is the one part of SAPU that needs keys: the RSC owner for the
            first two steps and the forwarder owner for the third. Every step is simulated before it is sent, and
            nothing is stored server-side.
          </p>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slate-500">
            Only here to check the deployment? The{" "}
            {readOnlyViews.map((view, index) => (
              <span key={view.id}>
                {index > 0 ? (index === readOnlyViews.length - 1 ? " and " : ", ") : ""}
                <Link
                  href={view.href}
                  className="text-slate-400 underline decoration-steel-bright underline-offset-2 hover:text-slate-200"
                >
                  {view.label}
                </Link>
              </span>
            ))}{" "}
            need no key and no wallet.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-slate-300">
            Every page under <code className="rounded bg-steel/70 px-1 font-mono text-[12px]">/app</code> proves the
            loop on-chain, read-only, with no key required. To see what SAPU is for, start at the{" "}
            <Link
              href="/"
              className="text-lime-glow underline decoration-lime-dim underline-offset-2 hover:decoration-lime"
            >
              landing page
            </Link>
            .
          </p>
          <p className="mt-1.5 max-w-3xl text-[12.5px] leading-relaxed text-slate-500">
            Arming a route is owner-only on this deployment and needs both the RSC owner and the forwarder owner.
            You can verify every leg yourself without one.
          </p>
        </>
      )}
    </section>
  );
}
