import { CircleCheck } from "lucide-react";
import { BrandMark } from "@/components/ProviderLogo";

const POINTS = [
  "Connect AWS, Azure and GCP with read-only access",
  "Recommendations sized on weeks of real usage, not snapshots",
  "Architecture changes priced before you make them",
];

/** Sign-in, sign-up and invitation pages: one calm form beside a short pitch. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="hidden flex-col justify-between bg-navy-900 px-12 py-10 text-navy-300 lg:flex">
        <div className="flex items-center gap-2.5">
          <BrandMark size={34} />
          <span className="text-[15px] font-semibold text-white">Cloud Price Optimizer</span>
        </div>
        <div>
          <p className="max-w-sm text-[26px] font-semibold leading-snug tracking-tight text-white">Spend less on cloud, without guessing.</p>
          <ul className="mt-6 space-y-3 text-[14px]">
            {POINTS.map((p) => (
              <li key={p} className="flex gap-2.5">
                <CircleCheck size={18} className="mt-0.5 shrink-0 text-blue-300" />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs">© {new Date().getFullYear()} Cloud Price Optimizer</p>
      </aside>
      <main className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <BrandMark size={30} />
            <span className="text-[15px] font-semibold">Cloud Price Optimizer</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
