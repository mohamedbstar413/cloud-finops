import { ResetForm } from "../../forms";

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  return <ResetForm token={(await params).token} />;
}
