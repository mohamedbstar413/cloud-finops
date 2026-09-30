import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gatekeeping before a request reaches the app. The real check
 * (a valid, unexpired session in the database) happens in pageSession() and
 * getSession(); this only avoids rendering app pages for visitors with no
 * session cookie at all, and blocks cross-site writes to the API.
 */
const SESSION_COOKIE = "cpo_session";
const PUBLIC_PAGES = ["/login", "/signup", "/forgot-password", "/reset-password", "/invite", "/demo"];
const PUBLIC_API = ["/api/auth/", "/api/billing/webhook", "/api/status"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // CSRF: state-changing API calls must come from this site (browsers always send Origin on POST/PATCH/DELETE).
  if (isApi && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !pathname.startsWith("/api/billing/webhook")) {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) {
      return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
    }
  }

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();
  if (isApi) {
    return PUBLIC_API.some((p) => pathname.startsWith(p)) ? NextResponse.next() : NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }
  if (PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" || pathname === "/dashboard" ? "" : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
