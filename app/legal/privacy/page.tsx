import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Scene Fixer",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-4 py-16">
      <div className="max-w-2xl mx-auto">
        <Link href="/" className="text-sm text-gray-500 hover:text-black transition-colors">
          ← Scene Fixer
        </Link>

        <h1 className="text-3xl font-bold text-black mt-6 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-400 mb-10">Effective date: May 21, 2026</p>

        <div className="prose prose-gray max-w-none text-sm leading-relaxed space-y-8">

          <section>
            <h2 className="text-base font-semibold text-black mb-2">1. Controller</h2>
            <p className="text-gray-600">
              The data controller for the Service is <strong>FredWorth GmbH</strong>,
              Witikonerstrasse 487, 8053 Zurich, Switzerland. Contact:{" "}
              <a href="mailto:business@alanany.com" className="text-black underline underline-offset-2">
                business@alanany.com
              </a>
            </p>
            <p className="text-gray-600 mt-3">
              This policy applies to users of Scene Fixer at scenefixer.com and is written in
              compliance with the Swiss Federal Act on Data Protection (nDSG) and, where applicable,
              the EU General Data Protection Regulation (GDPR).
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">2. Data We Collect</h2>

            <h3 className="text-sm font-semibold text-black mt-4 mb-1">Account data</h3>
            <p className="text-gray-600">
              When you sign in with Google, we receive your email address and Google user ID. We store
              these in our database to identify your account, associate your jobs with you, and send
              transactional communications.
            </p>

            <h3 className="text-sm font-semibold text-black mt-4 mb-1">Video content</h3>
            <p className="text-gray-600">
              Videos you upload are stored temporarily in Google Firebase Storage for the duration
              of processing and for as long as your account is active. We process them using AI
              services (Runway, Anthropic) to detect and fix continuity errors. We do not use your
              videos to train AI models.
            </p>

            <h3 className="text-sm font-semibold text-black mt-4 mb-1">Payment data</h3>
            <p className="text-gray-600">
              Payment information (card details) is collected and processed directly by Stripe. We
              store only your Stripe customer ID and subscription status. We never see or store raw
              card numbers.
            </p>

            <h3 className="text-sm font-semibold text-black mt-4 mb-1">Usage data</h3>
            <p className="text-gray-600">
              We store the number of fixes you have used in the current billing period to enforce
              plan limits. We may collect basic server logs (IP addresses, request timestamps) for
              security and debugging purposes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">3. Legal Basis for Processing</h2>
            <p className="text-gray-600">We process your personal data on the following bases:</p>
            <ul className="list-disc list-inside text-gray-600 mt-2 space-y-1">
              <li><strong>Contract performance</strong> — to provide the Service you signed up for</li>
              <li><strong>Legitimate interests</strong> — security, fraud prevention, product improvement</li>
              <li><strong>Legal obligation</strong> — where required by Swiss or applicable law</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">4. Third-Party Data Processors</h2>
            <p className="text-gray-600 mb-3">
              We share your data only with the following processors, each bound by data processing
              agreements:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-gray-600 border-collapse">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 pr-4 font-semibold text-black">Processor</th>
                    <th className="text-left py-2 pr-4 font-semibold text-black">Purpose</th>
                    <th className="text-left py-2 font-semibold text-black">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  <tr>
                    <td className="py-2 pr-4">Google Firebase</td>
                    <td className="py-2 pr-4">Authentication, database, file storage</td>
                    <td className="py-2">USA / EU</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Stripe</td>
                    <td className="py-2 pr-4">Payment processing</td>
                    <td className="py-2">USA / EU</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Runway ML</td>
                    <td className="py-2 pr-4">AI video generation (fix processing)</td>
                    <td className="py-2">USA</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Anthropic</td>
                    <td className="py-2 pr-4">AI analysis (continuity detection)</td>
                    <td className="py-2">USA</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Modal Labs</td>
                    <td className="py-2 pr-4">Compute infrastructure for processing</td>
                    <td className="py-2">USA</td>
                  </tr>
                  <tr>
                    <td className="py-2 pr-4">Vercel</td>
                    <td className="py-2 pr-4">Web hosting</td>
                    <td className="py-2">USA / EU</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-gray-600 mt-3">
              Transfers to processors in the USA are governed by Standard Contractual Clauses (SCCs)
              approved by the European Commission and recognised under Swiss law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">5. Data Retention</h2>
            <ul className="list-disc list-inside text-gray-600 space-y-1">
              <li>Account data is retained for as long as your account is active</li>
              <li>Uploaded videos and job outputs are retained while your account is active and deleted within 30 days of account deletion</li>
              <li>Payment records are retained for 10 years as required by Swiss commercial law</li>
              <li>Server logs are retained for up to 90 days</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">6. Your Rights</h2>
            <p className="text-gray-600 mb-3">
              Under the Swiss nDSG and GDPR (where applicable), you have the right to:
            </p>
            <ul className="list-disc list-inside text-gray-600 space-y-1">
              <li><strong>Access</strong> — request a copy of the personal data we hold about you</li>
              <li><strong>Rectification</strong> — ask us to correct inaccurate data</li>
              <li><strong>Erasure</strong> — request deletion of your data ("right to be forgotten")</li>
              <li><strong>Portability</strong> — receive your data in a structured, machine-readable format</li>
              <li><strong>Objection</strong> — object to processing based on legitimate interests</li>
              <li><strong>Restriction</strong> — ask us to restrict processing in certain circumstances</li>
            </ul>
            <p className="text-gray-600 mt-3">
              To exercise any of these rights, email{" "}
              <a href="mailto:business@alanany.com" className="text-black underline underline-offset-2">
                business@alanany.com
              </a>
              . We will respond within 30 days. If you are in the EU or Switzerland and believe we
              have violated your rights, you may lodge a complaint with the Swiss Federal Data
              Protection and Information Commissioner (FDPIC) at{" "}
              <span className="text-black">www.edoeb.admin.ch</span>.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">7. Cookies</h2>
            <p className="text-gray-600">
              We use only technically necessary cookies and browser storage (e.g. Firebase Auth
              session tokens, localStorage for recent jobs). We do not use tracking cookies or
              advertising cookies.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">8. Children</h2>
            <p className="text-gray-600">
              The Service is not directed at anyone under 16. If we become aware that we have
              collected data from a child under 16, we will delete it promptly. Contact us at
              business@alanany.com if you believe this has occurred.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">9. Changes to This Policy</h2>
            <p className="text-gray-600">
              We may update this Privacy Policy from time to time. We will notify you by email or
              prominent notice on the Service at least 14 days before material changes take effect.
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold text-black mb-2">10. Contact</h2>
            <p className="text-gray-600">
              Privacy questions or data requests:{" "}
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
