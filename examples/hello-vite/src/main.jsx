import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes } from "react-router-dom";

function Home() {
  return <h1>hello-vite: home</h1>;
}

function About() {
  return <h1>hello-vite: about (a client-side route)</h1>;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <nav>
        <Link to="/">Home</Link> | <Link to="/about">About</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
