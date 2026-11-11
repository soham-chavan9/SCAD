import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>hello-next-export: home</h1>
      <Link href="/about">About</Link>
    </main>
  );
}
