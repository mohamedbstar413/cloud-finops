"use client";

import clsx from "clsx";
import { Eye, EyeOff, PlayCircle } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { api, inputClass, Notice, Spinner } from "@/components/client-ui";
import { buttonClass } from "@/components/ui";

/** Only follow same-site relative paths after sign-in. */
const safeNext = (next: string | null | undefined, fallback: string) => (next && next.startsWith("/") && !next.startsWith("//") ? next : fallback);

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}

function PasswordInput({ value, onChange, autoComplete }: { value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} required value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} className={clsx(inputClass, "h-10 pr-10")} />
      <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-ink" aria-label={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

/** Submit JSON, then follow the `next` the API returns (full navigation, so the new session cookie is used everywhere). */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(url: string, body: unknown, next?: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ next?: string }>(url, { body });
      window.location.assign(next ?? r.next ?? "/dashboard");
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return { busy, error, submit };
}

export function DemoButton() {
  const { busy, error, submit } = useSubmit();
  return (
    <div>
      <button type="button" onClick={() => submit("/api/auth/demo", {})} disabled={busy} className={clsx(buttonClass("secondary"), "h-10 w-full")}>
        {busy ? <Spinner /> : <PlayCircle size={15} />} Explore the live demo
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

const Divider = () => (
  <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wide text-slate-400">
    <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
  </div>
);

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-[13px] text-muted">Welcome back.</p>
      {notice && (
        <div className="mt-4">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit("/api/auth/login", { email, password }, next ? safeNext(next, "/dashboard") : undefined);
        }}
      >
        <Field label="Work email">
          <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={clsx(inputClass, "h-10")} />
        </Field>
        <Field label="Password">
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </Field>
        <div className="flex justify-end">
          <Link href="/forgot-password" className="text-[12.5px] font-medium text-brand hover:underline">
            Forgot password?
          </Link>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
          {busy && <Spinner />} Sign in
        </button>
      </form>
      <Divider />
      <DemoButton />
      <p className="mt-6 text-center text-[13px] text-muted">
        New to Cloud Price Optimizer?{" "}
        <Link href="/signup" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}

export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organization, setOrganization] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-[13px] text-muted">Free for one cloud account. No credit card.</p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit("/api/auth/signup", { name, email, password, organization });
        }}
      >
        <Field label="Your name">
          <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={clsx(inputClass, "h-10")} />
        </Field>
        <Field label="Work email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={clsx(inputClass, "h-10")} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        <Field label="Company or team name" hint="Your organization. You can invite teammates later.">
          <input required value={organization} onChange={(e) => setOrganization(e.target.value)} autoComplete="organization" className={clsx(inputClass, "h-10")} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
          {busy && <Spinner />} Create account
        </button>
      </form>
      <p className="mt-6 text-center text-[13px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Reset your password</h1>
      {sent ? (
        <div className="mt-6">
          <Notice tone="success">If an account exists for {email}, a reset link is on its way. It expires in an hour.</Notice>
          <Link href="/login" className="mt-6 inline-block text-[13px] font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-muted">We&apos;ll email you a link to choose a new one.</p>
          <form
            className="mt-6 space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await api("/api/auth/forgot", { body: { email } });
                setSent(true);
              } catch (x) {
                setError((x as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Work email">
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={clsx(inputClass, "h-10")} />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <button type="submit" disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
              {busy && <Spinner />} Send reset link
            </button>
          </form>
          <Link href="/login" className="mt-6 inline-block text-[13px] font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </>
      )}
    </div>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Choose a new password</h1>
      <p className="mt-1 text-[13px] text-muted">You&apos;ll be signed out everywhere else.</p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit("/api/auth/reset", { token, password });
        }}
      >
        <Field label="New password" hint="At least 10 characters.">
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <button type="submit" disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
          {busy && <Spinner />} Save password
        </button>
      </form>
    </div>
  );
}

export function InviteSignupForm({ token, email, orgName }: { token: string; email: string; orgName: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/auth/invite/signup", { token, name, password });
      }}
    >
      <Field label="Email">
        <input value={email} disabled className={clsx(inputClass, "h-10 bg-slate-50 text-muted")} />
      </Field>
      <Field label="Your name">
        <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={clsx(inputClass, "h-10")} />
      </Field>
      <Field label="Password" hint="At least 10 characters.">
        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
        {busy && <Spinner />} Create account and join {orgName}
      </button>
    </form>
  );
}

export function AcceptInviteButton({ token, orgName }: { token: string; orgName: string }) {
  const { busy, error, submit } = useSubmit();
  return (
    <div className="mt-6">
      <button type="button" onClick={() => submit("/api/auth/invite/accept", { token })} disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
        {busy && <Spinner />} Join {orgName}
      </button>
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );
}

export function SignOutButton({ label = "Sign out", className }: { label?: string; className?: string }) {
  const { busy, submit } = useSubmit();
  return (
    <button type="button" onClick={() => submit("/api/auth/logout", {})} disabled={busy} className={className ?? "text-[13px] font-medium text-brand hover:underline"}>
      {label}
    </button>
  );
}

export function CreateOrganizationForm({ cta = "Create organization" }: { cta?: string }) {
  const [name, setName] = useState("");
  const { busy, error, submit } = useSubmit();
  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit("/api/orgs", { name });
      }}
    >
      <Field label="Company or team name">
        <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" className={clsx(inputClass, "h-10")} />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={clsx(buttonClass("primary"), "h-10 w-full")}>
        {busy && <Spinner />} {cta}
      </button>
    </form>
  );
}
