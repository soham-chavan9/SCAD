import { Link, useLoaderData } from "react-router";

export function loader() {
  return { time: new Date().toISOString() };
}

export default function Home() {
  const { time } = useLoaderData();
  return (
    <main>
      <h1>hello-remix: rendered on the server</h1>
      <p>server time: {time}</p>
      <Link to="/about">About</Link>
    </main>
  );
}
