import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteHeader, SiteFooter } from "@/components/site-chrome";
import { DOC_PAGES, findDoc } from "@/config/docs-content";

export function generateStaticParams() {
  return DOC_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findDoc(slug);
  if (!page) return { title: "Not found — SAPU" };
  return { title: `${page.title} — SAPU`, description: page.summary };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = findDoc(slug);
  if (!page) notFound();

  const others = DOC_PAGES.filter((candidate) => candidate.slug !== page.slug);

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-14">
        <Link href="/docs" className="font-mono text-[11px] text-slate-600 transition-colors hover:text-lime-glow">
          ← all docs
        </Link>

        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-50">{page.title}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-slate-400">{page.summary}</p>

        <div className="mt-10 space-y-10">
          {page.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="font-mono text-[13px] font-semibold uppercase tracking-[0.12em] text-lime-dim">
                {section.heading}
              </h2>

              <div className="mt-3 space-y-3">
                {section.body.map((paragraph, index) => (
                  <p key={index} className="text-[14px] leading-relaxed text-slate-300">
                    {paragraph}
                  </p>
                ))}
              </div>

              {section.list && (
                <ul className="mt-4 space-y-2">
                  {section.list.map((item, index) => (
                    <li key={index} className="flex gap-2.5 text-[13.5px] leading-relaxed text-slate-400">
                      <span className="mt-1 shrink-0 font-mono text-[10px] text-lime-dim">▸</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}

              {section.code && (
                <pre className="mt-4 overflow-x-auto rounded-md border border-steel bg-void/80 p-4 font-mono text-[11.5px] leading-relaxed text-slate-300">
                  <code>{section.code.content}</code>
                </pre>
              )}
            </section>
          ))}
        </div>

        <nav className="mt-14 border-t border-steel/60 pt-6">
          <p className="label-caps mb-3">Continue</p>
          <div className="flex flex-wrap gap-2">
            {others.map((other) => (
              <Link
                key={other.slug}
                href={`/docs/${other.slug}`}
                className="rounded border border-steel px-3 py-1.5 font-mono text-[11.5px] text-slate-400 transition-colors hover:border-steel-bright hover:text-lime-glow"
              >
                {other.title}
              </Link>
            ))}
          </div>
        </nav>
      </main>
      <SiteFooter />
    </>
  );
}
