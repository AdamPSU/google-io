import { SandboxClient } from "./SandboxClient";

export default async function SandboxPage({
  searchParams,
}: {
  searchParams: Promise<{ job_id?: string; name?: string }>;
}) {
  const { job_id, name } = await searchParams;
  return (
    <SandboxClient initialJobId={job_id ?? null} initialName={name ?? null} />
  );
}
