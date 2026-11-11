import Link from "next/link";

// Rendered on the server for every request.
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>hello-next: rendered on the server</h1>
      <p>server time: {new Date().toISOString()}</p>
      <Link href="/about">About</Link>
    </main>
  );
}
