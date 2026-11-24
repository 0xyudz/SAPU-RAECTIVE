import Link from "next/link";
import { SiteHeader, SiteFooter, BroomMark } from "@/components/site-chrome";
import { LandingLive } from "@/components/landing-live";
import { readProofFile } from "@/infrastructure/proof-file";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const proofResult = await readProofFile();

  return (
    <>
      <SiteHeader />

      <main className="mx-auto max-w-6xl px-5">
        <section className="pt-20 pb-16 sm:pt-28">
          <div className="flex items-center gap-2.5">
            <span className="pulse-dot" />
            <span className="label-caps">Reactive Omni · Track 2 · Set It and Forget It</span>
          </div>

          <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-slate-50 sm:text-6xl">
            Fund a burner wallet.
            <br />
            <span className="text-lime-glow">It empties itself</span>
            <br />
            before anyone can watch it fill.
          </h1>

          <p className="mt-7 max-w-2xl text-[15px] leading-relaxed text-slate-400">
            Withdrawing from a burner or an ERC-5564 stealth address normally needs native gas — and funding that
            gas from your main wallet links both addresses on-chain forever. That single transaction destroys the
            entire point of the burner.
          </p>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-300">
            SAPU removes the link. Register the burner once. A reactive contract on Reactive Omni subscribes to{" "}
            <code className="rounded bg-steel/70 px-1.5 py-0.5 font-mono text-[13px] text-lime-glow">Transfer</code>{" "}
            logs filtered on that address, and the instant tokens land, a forwarder sweeps them to your cold
            storage. The burner never needs gas. It never sends a transaction.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/app"
              className="group inline-flex items-center gap-2 rounded-md bg-lime px-5 py-2.5 font-mono text-sm font-semibold text-void transition-colors hover:bg-lime-glow"
            >
              Open app
              <span className="transition-transform group-hover:translate-x-0.5">→</span>
            </Link>
            <Link
              href="/app/arm"
              className="inline-flex items-center gap-2 rounded-md border border-lime-dim/60 px-5 py-2.5 font-mono text-sm text-lime-glow transition-colors hover:bg-lime/5"
            >
              Arm a route
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 rounded-md border border-steel px-5 py-2.5 font-mono text-sm text-slate-300 transition-colors hover:border-steel-bright hover:text-slate-100"
            >
              Read the spec
            </Link>
          </div>
        </section>

        <LandingLive
          proof={proofResult.proof}
          proofStatus={proofResult.status}
          proofError={proofResult.error}
        />

        <section className="pb-20">
          <h2 className="label-caps mb-5">The three-transaction loop</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <LoopCard
              index="01"
              chain="Base Sepolia"
              title="Deposit lands"
              body="Tokens arrive at the burner. A Transfer log is emitted with the burner in topic_2."
              detail="no gas in burner"
            />
            <LoopCard
              index="02"
              chain="Reactive Lasna"
              title="Reactive fires"
              body="SapuRSC matches the subscription, decodes the amount, and requests a callback to the forwarder."
              detail="~1s CometBFT finality"
            />
            <LoopCard
              index="03"
              chain="Base Sepolia"
              title="Sweep completes"
              body="SapuForwarder authenticates the callback and moves the tokens to your cold wallet."
              detail="burner left empty"
            />
          </div>
        </section>

        <section className="pb-20">
          <h2 className="label-caps mb-5">Why the link never forms</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Claim
              title="No native gas, ever"
              body="The burner holds zero ETH for its entire life. Foundry invariant tests assert burner.balance is 0 before and after the sweep."
            />
            <Claim
              title="No outbound transaction"
              body="The burner only ever appears as the recipient of a Transfer. It never signs, so it never leaves a fingerprint of intent."
            />
            <Claim
              title="Two independent auth checks"
              body="The forwarder verifies msg.sender is the callback proxy and that the injected sender is the authorized RSC. Either alone is forgeable."
            />
            <Claim
              title="Destination re-checked on-chain"
              body="The forwarder keeps its own cold-wallet registry. A compromised reactive contract still cannot redirect a sweep."
            />
          </div>
        </section>

        <section className="pb-20">
          <div className="panel p-6">
            <div className="flex items-start gap-3">
              <BroomMark className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <h2 className="font-mono text-sm font-semibold text-slate-100">What SAPU does not claim</h2>
                <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-slate-400">
                  Privacy is not anonymity. Sweeping funds promptly reduces the window in which a burner holds value,
                  but the deposit transaction itself is public and links the sender to the burner regardless. SAPU
                  removes the <em>funding</em> link between your main wallet and the burner — the one you would
                  otherwise create by sending gas. It does not obscure the deposit. See{" "}
                  <Link href="/docs/limitations" className="text-lime-glow underline decoration-lime-dim underline-offset-2 hover:decoration-lime">
                    limitations
                  </Link>
                  .
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}

function LoopCard({
  index,
  chain,
  title,
  body,
  detail,
}: {
  index: string;
  chain: string;
  title: string;
  body: string;
  detail: string;
}) {
  return (
    <div className="panel group relative overflow-hidden p-5 transition-colors hover:border-steel-bright">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-xs text-lime-dim">{index}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-600">{chain}</span>
      </div>
      <h3 className="mt-3 font-mono text-sm font-semibold text-slate-100">{title}</h3>
      <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{body}</p>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-lime-dim">{detail}</p>
    </div>
  );
}

function Claim({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-steel/70 p-5">
      <h3 className="flex items-center gap-2 font-mono text-[13px] font-semibold text-slate-200">
        <span className="text-lime">✓</span>
        {title}
      </h3>
      <p className="mt-2 text-[13px] leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}
