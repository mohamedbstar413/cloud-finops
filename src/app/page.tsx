import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const s = await currentUser();
  redirect(!s ? "/login" : s.org ? "/dashboard" : "/welcome");
}
