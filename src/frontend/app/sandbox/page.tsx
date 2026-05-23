import { SandboxClient } from "./SandboxClient";

export default async function SandboxPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string }>;
}) {
  const { url } = await searchParams;
  return <SandboxClient initialUrl={url ?? null} />;
}
