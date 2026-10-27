import type { Metadata } from "next";
import LabApp from "@/components/lab/LabApp";
import { labEnabled } from "@/lib/lab/auth";

// Private tester page: kept out of search and out of the sitemap, and nothing
// on the site links here.
export const metadata: Metadata = {
  title: "Scene Fixer Lab",
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = "force-dynamic";

export default function LabPage() {
  return <LabApp enabled={labEnabled()} />;
}
