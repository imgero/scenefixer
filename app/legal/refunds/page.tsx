import Link from "next/link";

export const metadata = {
  title: "Refund Policy — Scene Fixer",
};

export default function RefundsPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16">
      <div className="max-w-2xl mx-auto">
        <Link href="/" className="text-sm text-gray-500 hover:text-black transition-colors">
          ← Scene Fixer
        </Link>

        <h1 className="text-3xl font-bold text-black mt-6 mb-2">Refund Policy</h1>
        <p className="text-sm text-gray-400 mb-10">Effective date: October 28, 2026</p>

        <div className="prose prose-gray max-w-none text-sm leading-relaxed space-y-8">

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Scans</h2>
            <p className="text-gray-600">
              The quick scan with Claude Haiku is free and never uses credits. The deep scan with
              Claude Opus is optional and uses <strong>one credit per shot</strong>; you see the
              price before you start it.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Credit Packs</h2>
            <p className="text-gray-600">
              Credits pay for fixes and deep scans. Each fix uses <strong>one credit per second of
              the shot it repairs</strong>: a fix in an 8-second shot uses 8 credits. Credits never
              expire.
            </p>
            <p className="text-gray-600 mt-3">
              If you haven&apos;t used any credits from a pack, you can request a{" "}
              <strong>full refund within 14 days of buying it</strong>. Once credits from a pack
              have been spent on fixes or deep scans, that pack is no longer refundable.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Fixes and Scans That Don&apos;t Land</h2>
            <p className="text-gray-600">
              If a fix fails, or runs but leaves the error visible, the credits it used are
              returned to your account automatically. The same goes for a deep scan that
              doesn&apos;t finish. You don&apos;t need to ask.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">How to Request a Refund</h2>
            <p className="text-gray-600">
              Email{" "}
              <a href="mailto:business@alanany.com" className="text-black underline underline-offset-2">
                business@alanany.com
              </a>{" "}
              with the subject line <strong>"Refund Request"</strong> and include the email address
              associated with your Scene Fixer account. We will process your refund within
              <strong> 5 business days</strong>.
            </p>
            <p className="text-gray-600 mt-3">
              Refunds are returned to the original payment method via Stripe. Depending on your bank,
              funds may take an additional 5–10 business days to appear on your statement.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Earlier Subscriptions</h2>
            <p className="text-gray-600">
              We no longer sell subscriptions. If you subscribed to a Starter, Pro, or Studio plan,
              you can request a full refund within 14 days of your first subscription payment.
              Renewal charges after that are non-refundable. You can cancel at any time from the
              pricing page; cancellation takes effect at the end of the current billing period and
              you keep access until then.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Exceptions</h2>
            <p className="text-gray-600">
              We reserve the right to decline a refund if we have reasonable evidence of abuse (e.g.
              repeated sign-ups across multiple accounts, or repeated buy-and-refund cycles).
              Outside the 14-day window, refunds may be issued at our discretion for documented
              technical failures that prevented use of the Service — contact us and we will review
              on a case-by-case basis.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Contact</h2>
            <p className="text-gray-600">
              Questions about billing or refunds:{" "}
              <a href="mailto:business@alanany.com" className="text-black underline underline-offset-2">
                business@alanany.com
              </a>
              <br />
              FredWorth GmbH · Witikonerstrasse 487 · 8053 Zurich · Switzerland
            </p>
          </section>

        </div>
      </div>
    </main>
  );
}
