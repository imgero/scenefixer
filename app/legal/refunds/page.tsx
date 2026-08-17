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
        <p className="text-sm text-gray-400 mb-10">Effective date: May 21, 2026</p>

        <div className="prose prose-gray max-w-none text-sm leading-relaxed space-y-8">

          <section>
            <h2 className="text-base font-semibold text-black mb-2">14-Day Money-Back Guarantee</h2>
            <p className="text-gray-600">
              If you are not satisfied with Scene Fixer for any reason, you can request a full refund
              within <strong>14 days of your first payment</strong> on any paid plan (Starter, Pro,
              or Studio). No questions asked.
            </p>
            <p className="text-gray-600 mt-3">
              This guarantee applies once per customer. It covers the first subscription payment only
              — not subsequent renewal charges.
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
            <h2 className="text-base font-semibold text-black mb-2">Renewal Charges</h2>
            <p className="text-gray-600">
              After the initial 14-day guarantee period, subscription renewals (monthly or annual)
              are non-refundable. You can cancel your subscription at any time from your account —
              cancellation takes effect at the end of the current billing period and you retain
              access until then.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Exceptions</h2>
            <p className="text-gray-600">
              We reserve the right to decline a refund if we have reasonable evidence of abuse (e.g.
              repeated sign-ups across multiple accounts to claim multiple guarantees). Outside the
              14-day window, refunds may be issued at our discretion for documented technical failures
              that prevented use of the Service — contact us and we will review on a case-by-case
              basis.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">Free Plan</h2>
            <p className="text-gray-600">
              The Free plan is free of charge — no refunds apply as no payment is taken.
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
