import type { Metadata } from "next";
import InvitationExperience from "@/components/InvitationExperience";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { BRAND } from "@/lib/brand";

/*
 * /invite#<token>: the page an invitation link opens. Static, like the rest
 * of the site: the token is read in the browser from the fragment, never
 * from the path, so no server or rewrite is involved and the token is never
 * in this page's HTML or metadata.
 */
export const metadata: Metadata = {
  title: `You're invited · ${BRAND.name}`,
  robots: { index: false, follow: false },
};

export default function InvitePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex flex-1 items-center bg-canvas px-4 py-12 sm:px-6 sm:py-20">
        <InvitationExperience />
      </main>
      <SiteFooter />
    </div>
  );
}
