import * as React from "react";
import { Link } from "gatsby";

export default function Home() {
  return (
    <main>
      <h1>hello-gatsby: home</h1>
      <Link to="/about/">About</Link>
    </main>
  );
}

export const Head = () => <title>hello-gatsby</title>;
