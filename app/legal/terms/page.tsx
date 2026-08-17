import Link from "next/link";

export const metadata = {
  title: "Terms of Service — Scene Fixer",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16">
      <div className="max-w-2xl mx-auto">
        <Link href="/" className="text-sm text-gray-500 hover:text-black transition-colors">
          ← Scene Fixer
        </Link>

        <h1 className="text-3xl font-bold text-black mt-6 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-400 mb-10">Effective date: May 21, 2026</p>

        <div className="prose prose-gray max-w-none text-sm leading-relaxed space-y-8">

          <section>
            <h2 className="text-base font-semibold text-black mb-2">1. Who We Are</h2>
            <p className="text-gray-600">
              Scene Fixer is operated by <strong>FredWorth GmbH</strong>, Witikonerstrasse 487,
              8053 Zurich, Switzerland ("<strong>we</strong>", "<strong>us</strong>", "<strong>our</strong>").
              By using Scene Fixer at scenefixer.com (the "<strong>Service</strong>"), you agree to
              these Terms of Service ("<strong>Terms</strong>").
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">2. Eligibility</h2>
            <p className="text-gray-600">
              You must be at least <strong>16 years old</strong> to use the Service. By creating an
              account, you confirm that you meet this requirement. If you are using the Service on
              behalf of a company or organisation, you represent that you have authority to bind that
              entity to these Terms.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">3. Description of Service</h2>
            <p className="text-gray-600">
              Scene Fixer is an AI-powered tool that analyses video files for continuity errors and
              applies AI-generated fixes to selected frames. The Service uses third-party AI models
              (including Runway and Anthropic) to process your uploads. Results are not guaranteed to
              be perfect — AI-generated edits may produce artefacts or unexpected output.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">4. Accounts</h2>
            <p className="text-gray-600">
              You sign in via Google OAuth. You are responsible for maintaining the security of your
              account. We are not liable for any loss resulting from unauthorised access to your
              account. You may not share your account with others or use the Service to process videos
              on behalf of third parties under a single account without a separate agreement.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">5. Subscriptions and Payment</h2>
            <p className="text-gray-600 mb-3">
              Paid plans (Starter, Pro, Studio) are billed monthly or annually through Stripe. Prices
              are shown in USD and exclusive of any applicable taxes. We reserve the right to change
              pricing with 30 days' notice.
            </p>
            <p className="text-gray-600">
              Fix quotas (fixes per month) reset on the first day of each calendar month. Unused fixes
              do not carry over. Downgrading your plan takes effect at the end of your current billing
              period.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">6. Refunds</h2>
            <p className="text-gray-600">
              We offer a <strong>14-day money-back guarantee</strong> on all paid plans. If you are
              not satisfied, contact us at{" "}
              <a href="mailto:business@alanany.com" className="text-black underline underline-offset-2">
                business@alanany.com
              </a>{" "}
              within 14 days of your first payment. See our{" "}
              <Link href="/legal/refunds" className="text-black underline underline-offset-2">
                Refund Policy
              </Link>{" "}
              for full details.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">7. Your Content</h2>
            <p className="text-gray-600 mb-3">
              You retain all ownership rights to videos you upload. By uploading, you grant us a
              limited, temporary licence to store and process your content solely to provide the
              Service. We do not use your videos to train AI models.
            </p>
            <p className="text-gray-600">
              You are solely responsible for ensuring you have the right to upload and process any
              video. Do not upload content that infringes third-party intellectual property rights,
              contains illegal material, or violates the rights of any person depicted.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">8. Acceptable Use</h2>
            <p className="text-gray-600">You agree not to:</p>
            <ul className="list-disc list-inside text-gray-600 mt-2 space-y-1">
              <li>Reverse-engineer, scrape, or abuse the Service or its APIs</li>
              <li>Attempt to circumvent usage limits or billing</li>
              <li>Use the Service to generate deepfakes of real persons without consent</li>
              <li>Upload content that is defamatory, obscene, or illegal under Swiss law</li>
              <li>Share account credentials or resell access to the Service</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">9. Intellectual Property</h2>
            <p className="text-gray-600">
              The Scene Fixer name, logo, website design, and software are owned by FredWorth GmbH.
              Nothing in these Terms transfers any ownership of our intellectual property to you.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">10. Disclaimer of Warranties</h2>
            <p className="text-gray-600">
              The Service is provided "<strong>as is</strong>" without warranties of any kind. We do
              not guarantee that the Service will be uninterrupted, error-free, or that AI-generated
              fixes will meet your expectations. AI output is probabilistic and may produce
              imperfect results.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">11. Limitation of Liability</h2>
            <p className="text-gray-600">
              To the maximum extent permitted by Swiss law, FredWorth GmbH's total liability to you
              for any claim arising from the Service is limited to the amount you paid us in the
              3 months preceding the claim. We are not liable for indirect, incidental, or
              consequential damages.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">12. Termination</h2>
            <p className="text-gray-600">
              You may cancel your account at any time. We may suspend or terminate your account if
              you violate these Terms. Upon termination, your right to use the Service ceases and
              your stored data will be deleted within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">13. Changes to These Terms</h2>
            <p className="text-gray-600">
              We may update these Terms from time to time. We will notify you by email or by a
              prominent notice on the Service at least 14 days before changes take effect. Continued
              use after that date constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">14. Governing Law</h2>
            <p className="text-gray-600">
              These Terms are governed by the laws of Switzerland. Any disputes shall be subject to
              the exclusive jurisdiction of the courts of the Canton of Zurich, Switzerland.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">15. Contact</h2>
            <p className="text-gray-600">
              Questions about these Terms:{" "}
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
