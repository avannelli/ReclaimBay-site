import ScannerApp from "@/components/ScannerApp";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <ScannerApp />
      <SiteFooter />
    </div>
  );
}
