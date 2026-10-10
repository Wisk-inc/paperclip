/**
 * Studio's language catalog: every language and stack you can start an app
 * in. Each entry carries a runnable starter project, the command that runs
 * it (in the project folder, with `$PORT` set for web apps), the program the
 * host needs, and how to install that program on Termux, Debian/Ubuntu, and
 * macOS. Web entries serve on `$PORT`; static entries are served by Automa
 * itself and need nothing installed.
 */

export type StudioLanguageCategory =
  | "popular"
  | "web"
  | "backend"
  | "mobile"
  | "systems"
  | "jvm-dotnet"
  | "scripting"
  | "functional"
  | "data"
  | "classic"
  | "esoteric";

export const STUDIO_LANGUAGE_CATEGORIES: ReadonlyArray<{ id: StudioLanguageCategory; label: string }> = [
  { id: "popular", label: "Popular" },
  { id: "web", label: "Web & full stack" },
  { id: "backend", label: "Servers & APIs" },
  { id: "mobile", label: "Mobile" },
  { id: "systems", label: "Systems" },
  { id: "jvm-dotnet", label: "JVM & .NET" },
  { id: "scripting", label: "Scripting & shells" },
  { id: "functional", label: "Functional" },
  { id: "data", label: "Data & science" },
  { id: "classic", label: "Classic" },
  { id: "esoteric", label: "Just for fun" },
];

/** `cli`: runs and prints; `web`: a server on `$PORT`; `static`: files Automa serves. */
export type StudioLanguageKind = "cli" | "web" | "static";

export interface StudioInstallHints {
  /** Packages for `pkg install` in Termux (Android). Null when Termux has none. */
  termux: string | null;
  /** Packages for `apt install` on Debian/Ubuntu. */
  debian: string | null;
  /** Formula for `brew install` on macOS. */
  mac: string | null;
  /** Anything else worth knowing (for example "needs internet for npm install"). */
  note?: string;
}

export interface StudioLanguage {
  id: string;
  name: string;
  /** Two or three letters for the badge. */
  abbr: string;
  /** Badge color (the language's usual brand color). */
  color: string;
  category: StudioLanguageCategory;
  /** Extra search words. */
  aliases: readonly string[];
  kind: StudioLanguageKind;
  /** The file opened first. */
  entry: string;
  /** Starter files, path → contents. */
  files: Readonly<Record<string, string>>;
  /** Shell command that runs the project; empty for static sites. */
  run: string;
  /** Program that must be on PATH to run it (null for static sites). */
  requires: string | null;
  install: StudioInstallHints;
  /** CodeMirror language name (from @codemirror/language-data) for highlighting. */
  editor: string;
  /** Shown in the picker under the name. */
  blurb: string;
  /** Listed under Popular as well as its own category. */
  popular?: boolean;
}

const NODE_INSTALL: StudioInstallHints = { termux: "nodejs-lts", debian: "nodejs", mac: "node" };
const PYTHON_INSTALL: StudioInstallHints = { termux: "python", debian: "python3", mac: "python" };

const HTML_STARTER = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My app</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main>
    <h1>Hello, world!</h1>
    <p>Edit <code>index.html</code>, <code>style.css</code>, and <code>script.js</code>, then tap Run.</p>
    <button id="count">Clicked 0 times</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
`;

const STYLE_STARTER = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { max-width: 32rem; padding: 2rem; text-align: center; }
button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 0.6rem; border: 1px solid currentColor; background: none; cursor: pointer; }
`;

const SCRIPT_STARTER = `let count = 0;
const button = document.getElementById("count");
button.addEventListener("click", () => {
  count += 1;
  button.textContent = \`Clicked \${count} time\${count === 1 ? "" : "s"}\`;
});
`;

const FULLSTACK_SERVER = `// A full-stack starter with no dependencies: a web server, a JSON API, and a
// SQLite database (built into Node.js 22.5+). Run it, then open the preview.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { extname, join } from "node:path";

const db = new DatabaseSync("data.db");
db.exec("CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)");

const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/todos" && req.method === "GET") {
    return send(res, 200, db.prepare("SELECT id, text, done FROM todos ORDER BY id").all());
  }
  if (url.pathname === "/api/todos" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = String(JSON.parse(body || "{}").text ?? "").trim();
    if (!text) return send(res, 400, { error: "text is required" });
    const info = db.prepare("INSERT INTO todos (text) VALUES (?)").run(text);
    return send(res, 201, { id: Number(info.lastInsertRowid), text, done: 0 });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const content = await readFile(join("public", file));
    send(res, 200, content, types[extname(file)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "127.0.0.1", () => console.log(\`Listening on http://127.0.0.1:\${port}\`));
`;

const FULLSTACK_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Todos</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
    form { display: flex; gap: 0.5rem; }
    input { flex: 1; font: inherit; padding: 0.5rem; }
  </style>
</head>
<body>
  <h1>Todos</h1>
  <form id="add"><input name="text" placeholder="Something to do" required><button>Add</button></form>
  <ul id="list"></ul>
  <script>
    const list = document.getElementById("list");
    async function load() {
      const todos = await (await fetch("api/todos")).json();
      list.innerHTML = "";
      for (const todo of todos) {
        const item = document.createElement("li");
        item.textContent = todo.text;
        list.append(item);
      }
    }
    document.getElementById("add").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      await fetch("api/todos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: form.text.value }) });
      form.reset();
      load();
    });
    load();
  </script>
</body>
</html>
`;

function cli(
  id: string,
  name: string,
  abbr: string,
  color: string,
  category: StudioLanguageCategory,
  entry: string,
  source: string,
  run: string,
  requires: string,
  install: StudioInstallHints,
  editor: string,
  blurb: string,
  extra: Partial<StudioLanguage> = {},
): StudioLanguage {
  return {
    id,
    name,
    abbr,
    color,
    category,
    aliases: [],
    kind: "cli",
    entry,
    files: { [entry]: source },
    run,
    requires,
    install,
    editor,
    blurb,
    ...extra,
  };
}

export const STUDIO_LANGUAGES: readonly StudioLanguage[] = [
  // ── Popular ────────────────────────────────────────────────────────────
  cli("python", "Python", "Py", "#3776AB", "popular", "main.py",
    `def greet(name: str) -> str:\n    return f"Hello, {name}!"\n\n\nprint(greet("world"))\n`,
    "python3 main.py", "python3", PYTHON_INSTALL, "Python", "Scripts, automation, AI, and more", { aliases: ["py", "python3"], popular: true }),
  cli("javascript", "JavaScript (Node.js)", "JS", "#F7DF1E", "popular", "index.js",
    `console.log("Hello, world!");\n`,
    "node index.js", "node", NODE_INSTALL, "JavaScript", "JavaScript on the server", { aliases: ["js", "node", "nodejs", "ecmascript"], popular: true }),
  cli("typescript", "TypeScript", "TS", "#3178C6", "popular", "index.ts",
    `const greet = (name: string): string => \`Hello, \${name}!\`;\nconsole.log(greet("world"));\n`,
    "node index.ts", "node", { ...NODE_INSTALL, note: "Needs Node.js 23.6 or newer (runs TypeScript directly)." }, "TypeScript", "JavaScript with types, run by Node.js", { aliases: ["ts"], popular: true }),
  {
    id: "html",
    name: "Website (HTML, CSS & JS)",
    abbr: "WEB",
    color: "#E34F26",
    category: "popular",
    aliases: ["html", "css", "website", "static", "frontend", "page"],
    kind: "static",
    entry: "index.html",
    files: { "index.html": HTML_STARTER, "style.css": STYLE_STARTER, "script.js": SCRIPT_STARTER },
    run: "",
    requires: null,
    install: { termux: null, debian: null, mac: null, note: "Nothing to install: Automa serves it." },
    editor: "HTML",
    blurb: "A web page you can open on any device",
    popular: true,
  },
  {
    id: "fullstack-node",
    name: "Full-stack app (Node.js + SQLite)",
    abbr: "FS",
    color: "#43853D",
    category: "popular",
    aliases: ["full stack", "fullstack", "database", "sqlite", "api", "backend", "todo", "crud"],
    kind: "web",
    entry: "server.js",
    files: { "server.js": FULLSTACK_SERVER, "public/index.html": FULLSTACK_PAGE, "package.json": `{\n  "name": "my-app",\n  "private": true,\n  "type": "module"\n}\n` },
    run: "node server.js",
    requires: "node",
    install: { ...NODE_INSTALL, note: "Uses Node.js's built-in SQLite (Node 22.5+); no npm install." },
    editor: "JavaScript",
    blurb: "Web page, JSON API, and a database",
    popular: true,
  },
  cli("go", "Go", "Go", "#00ADD8", "popular", "main.go",
    `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, world!")\n}\n`,
    "go run main.go", "go", { termux: "golang", debian: "golang-go", mac: "go" }, "Go", "Fast, simple, compiled", { aliases: ["golang"], popular: true }),
  cli("rust", "Rust", "Rs", "#DEA584", "popular", "main.rs",
    `fn main() {\n    println!("Hello, world!");\n}\n`,
    "rustc main.rs -o main && ./main", "rustc", { termux: "rust", debian: "rustc", mac: "rust" }, "Rust", "Safe and fast systems code", { aliases: ["rs", "cargo"], popular: true }),
  cli("java", "Java", "Jv", "#E76F00", "popular", "Main.java",
    `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, world!");\n    }\n}\n`,
    "java Main.java", "java", { termux: "openjdk-21", debian: "default-jdk", mac: "openjdk" }, "Java", "Runs a single file with Java 11+", { aliases: ["jdk", "openjdk"], popular: true }),
  cli("c", "C", "C", "#555555", "popular", "main.c",
    `#include <stdio.h>\n\nint main(void) {\n    printf("Hello, world!\\n");\n    return 0;\n}\n`,
    "cc main.c -o main && ./main", "cc", { termux: "clang", debian: "gcc", mac: null, note: "On macOS, install the Xcode command line tools (xcode-select --install)." }, "C", "The classic systems language", { popular: true }),
  cli("cpp", "C++", "C++", "#00599C", "popular", "main.cpp",
    `#include <iostream>\n\nint main() {\n    std::cout << "Hello, world!" << std::endl;\n    return 0;\n}\n`,
    "c++ -std=c++17 main.cpp -o main && ./main", "c++", { termux: "clang", debian: "g++", mac: null, note: "On macOS, install the Xcode command line tools (xcode-select --install)." }, "C++", "Games, engines, and fast code", { aliases: ["cplusplus", "cxx"], popular: true }),

  // ── Web & full stack ─────────────────────────────────────────────────────
  {
    id: "react",
    name: "React (no build step)",
    abbr: "Re",
    color: "#61DAFB",
    category: "web",
    aliases: ["reactjs", "jsx", "frontend", "spa"],
    kind: "static",
    entry: "app.js",
    files: {
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>React app</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="app.js"></script>\n</body>\n</html>\n`,
      "app.js": `// React straight from a CDN: no npm install, no build. The viewer needs internet.\nimport React, { useState } from "https://esm.sh/react@19";\nimport { createRoot } from "https://esm.sh/react-dom@19/client";\n\nconst h = React.createElement;\n\nfunction App() {\n  const [count, setCount] = useState(0);\n  return h("main", { style: { fontFamily: "system-ui", textAlign: "center", marginTop: "4rem" } },\n    h("h1", null, "Hello from React!"),\n    h("button", { onClick: () => setCount(count + 1) }, \`Clicked \${count} times\`));\n}\n\ncreateRoot(document.getElementById("root")).render(h(App));\n`,
    },
    run: "",
    requires: null,
    install: { termux: null, debian: null, mac: null, note: "Loads React from esm.sh, so the page needs internet." },
    editor: "JavaScript",
    blurb: "React components in the browser",
  },
  {
    id: "vite-react",
    name: "Vite + React",
    abbr: "Vi",
    color: "#646CFF",
    category: "web",
    aliases: ["vite", "react", "npm", "frontend", "spa", "typescript"],
    kind: "web",
    entry: "src/App.jsx",
    files: {
      "package.json": `{\n  "name": "vite-react-app",\n  "private": true,\n  "type": "module",\n  "scripts": { "dev": "vite" },\n  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },\n  "devDependencies": { "vite": "^6.0.0", "@vitejs/plugin-react": "^4.3.0" }\n}\n`,
      "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()], base: "./" });\n`,
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Vite + React</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>\n`,
      "src/main.jsx": `import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
      "src/App.jsx": `import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main style={{ fontFamily: "system-ui", textAlign: "center", marginTop: "4rem" }}>\n      <h1>Hello from Vite + React!</h1>\n      <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>\n    </main>\n  );\n}\n`,
    },
    run: "npm install --no-audit --no-fund && npx vite --host 127.0.0.1 --port $PORT --strictPort",
    requires: "npm",
    install: { ...NODE_INSTALL, note: "The first run downloads packages with npm (needs internet)." },
    editor: "JSX",
    blurb: "The modern React toolchain",
  },
  {
    id: "vue",
    name: "Vue (no build step)",
    abbr: "Vue",
    color: "#41B883",
    category: "web",
    aliases: ["vuejs", "frontend", "spa"],
    kind: "static",
    entry: "index.html",
    files: {
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Vue app</title>\n</head>\n<body>\n  <div id="app" style="font-family: system-ui; text-align: center; margin-top: 4rem">\n    <h1>{{ message }}</h1>\n    <button @click="count++">Clicked {{ count }} times</button>\n  </div>\n  <script type="module">\n    import { createApp } from "https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js";\n    createApp({ data: () => ({ message: "Hello from Vue!", count: 0 }) }).mount("#app");\n  </script>\n</body>\n</html>\n`,
    },
    run: "",
    requires: null,
    install: { termux: null, debian: null, mac: null, note: "Loads Vue from unpkg, so the page needs internet." },
    editor: "HTML",
    blurb: "Vue in the browser",
  },
  {
    id: "express",
    name: "Express API",
    abbr: "Ex",
    color: "#353535",
    category: "web",
    aliases: ["express", "node", "rest", "api", "backend", "server"],
    kind: "web",
    entry: "server.js",
    files: {
      "package.json": `{\n  "name": "express-api",\n  "private": true,\n  "type": "module",\n  "dependencies": { "express": "^5.1.0" }\n}\n`,
      "server.js": `import express from "express";\n\nconst app = express();\napp.use(express.json());\n\napp.get("/", (_req, res) => res.send("<h1>Hello from Express!</h1><p>Try <a href='api/hello'>api/hello</a>.</p>"));\napp.get("/api/hello", (_req, res) => res.json({ message: "Hello, world!" }));\n\nconst port = Number(process.env.PORT ?? 3000);\napp.listen(port, "127.0.0.1", () => console.log(\`Listening on http://127.0.0.1:\${port}\`));\n`,
    },
    run: "npm install --no-audit --no-fund && node server.js",
    requires: "npm",
    install: { ...NODE_INSTALL, note: "The first run downloads Express with npm (needs internet)." },
    editor: "JavaScript",
    blurb: "A REST API with Express",
  },
  {
    id: "python-web",
    name: "Python web server",
    abbr: "PyW",
    color: "#306998",
    category: "web",
    aliases: ["python", "http", "server", "api", "stdlib"],
    kind: "web",
    entry: "app.py",
    files: {
      "app.py": `"""A small web app using only Python's standard library."""\nimport json\nimport os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\n\n\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        if self.path.startswith("/api/hello"):\n            body = json.dumps({"message": "Hello, world!"}).encode()\n            content_type = "application/json"\n        else:\n            body = b"<h1>Hello from Python!</h1><p>Try <a href='api/hello'>api/hello</a>.</p>"\n            content_type = "text/html"\n        self.send_response(200)\n        self.send_header("Content-Type", content_type)\n        self.end_headers()\n        self.wfile.write(body)\n\n\nport = int(os.environ.get("PORT", "8000"))\nprint(f"Listening on http://127.0.0.1:{port}", flush=True)\nHTTPServer(("127.0.0.1", port), Handler).serve_forever()\n`,
    },
    run: "python3 app.py",
    requires: "python3",
    install: PYTHON_INSTALL,
    editor: "Python",
    blurb: "A web app with no packages to install",
  },
  {
    id: "flask",
    name: "Flask",
    abbr: "Fl",
    color: "#000000",
    category: "web",
    aliases: ["python", "flask", "api", "backend"],
    kind: "web",
    entry: "app.py",
    files: {
      "requirements.txt": "flask>=3\n",
      "app.py": `import os\nfrom flask import Flask, jsonify\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef index():\n    return "<h1>Hello from Flask!</h1><p>Try <a href='api/hello'>api/hello</a>.</p>"\n\n\n@app.get("/api/hello")\ndef hello():\n    return jsonify(message="Hello, world!")\n\n\nif __name__ == "__main__":\n    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))\n`,
    },
    run: "python3 -m pip install -q -r requirements.txt && python3 app.py",
    requires: "python3",
    install: { ...PYTHON_INSTALL, note: "The first run installs Flask with pip (needs internet)." },
    editor: "Python",
    blurb: "Python's lightweight web framework",
  },
  {
    id: "fastapi",
    name: "FastAPI",
    abbr: "FA",
    color: "#009688",
    category: "web",
    aliases: ["python", "fastapi", "api", "backend", "uvicorn"],
    kind: "web",
    entry: "main.py",
    files: {
      "requirements.txt": "fastapi>=0.115\nuvicorn>=0.32\n",
      "main.py": `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/")\ndef index():\n    return {"message": "Hello from FastAPI! Open /docs for the API explorer."}\n`,
    },
    run: "python3 -m pip install -q -r requirements.txt && python3 -m uvicorn main:app --host 127.0.0.1 --port $PORT",
    requires: "python3",
    install: { ...PYTHON_INSTALL, note: "The first run installs FastAPI with pip (needs internet)." },
    editor: "Python",
    blurb: "Fast Python APIs with automatic docs",
  },
  {
    id: "php-web",
    name: "PHP website",
    abbr: "PHW",
    color: "#4F5D95",
    category: "web",
    aliases: ["php", "server"],
    kind: "web",
    entry: "index.php",
    files: { "index.php": `<?php $name = "world"; ?>\n<!doctype html>\n<html><body style="font-family: system-ui">\n  <h1>Hello, <?= htmlspecialchars($name) ?>!</h1>\n  <p>The time on the server is <?= date("H:i:s") ?>.</p>\n</body></html>\n` },
    run: "php -S 127.0.0.1:$PORT",
    requires: "php",
    install: { termux: "php", debian: "php-cli", mac: "php" },
    editor: "PHP",
    blurb: "PHP's built-in web server",
  },
  {
    id: "go-web",
    name: "Go web server",
    abbr: "GoW",
    color: "#007D9C",
    category: "backend",
    aliases: ["go", "golang", "http", "api"],
    kind: "web",
    entry: "main.go",
    files: { "main.go": `package main\n\nimport (\n\t"fmt"\n\t"log"\n\t"net/http"\n\t"os"\n)\n\nfunc main() {\n\thttp.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {\n\t\tfmt.Fprintln(w, "<h1>Hello from Go!</h1>")\n\t})\n\tport := os.Getenv("PORT")\n\tif port == "" {\n\t\tport = "8080"\n\t}\n\tlog.Printf("Listening on http://127.0.0.1:%s", port)\n\tlog.Fatal(http.ListenAndServe("127.0.0.1:"+port, nil))\n}\n` },
    run: "go run main.go",
    requires: "go",
    install: { termux: "golang", debian: "golang-go", mac: "go" },
    editor: "Go",
    blurb: "An HTTP server in Go's standard library",
  },
  cli("deno", "Deno", "De", "#000000", "backend", "main.ts",
    `console.log("Hello from Deno!");\n`,
    "deno run main.ts", "deno", { termux: null, debian: null, mac: "deno", note: "Install from deno.com on Linux." }, "TypeScript", "Secure JavaScript and TypeScript runtime"),
  cli("bun", "Bun", "Bun", "#FBF0DF", "backend", "index.ts",
    `console.log("Hello from Bun!");\n`,
    "bun run index.ts", "bun", { termux: null, debian: null, mac: "oven-sh/bun/bun", note: "Install from bun.sh on Linux." }, "TypeScript", "Fast all-in-one JavaScript runtime"),

  // ── Mobile ───────────────────────────────────────────────────────────────
  {
    id: "pwa",
    name: "Mobile app (PWA)",
    abbr: "App",
    color: "#5A0FC8",
    category: "mobile",
    aliases: ["mobile", "android", "ios", "pwa", "app", "install", "phone"],
    kind: "static",
    entry: "index.html",
    files: {
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n  <meta name="theme-color" content="#5A0FC8">\n  <link rel="manifest" href="manifest.json">\n  <title>My phone app</title>\n  <style>\n    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }\n    body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: env(safe-area-inset-top) 1rem env(safe-area-inset-bottom); }\n    button { font: inherit; font-size: 1.25rem; padding: 1rem 2rem; border-radius: 999px; border: 0; background: #5A0FC8; color: white; }\n  </style>\n</head>\n<body>\n  <main style="text-align: center">\n    <h1>My phone app</h1>\n    <p>Open the public link on your phone and choose "Add to Home screen".</p>\n    <button id="tap">Tap me</button>\n    <p id="taps">0 taps</p>\n  </main>\n  <script>\n    let taps = 0;\n    document.getElementById("tap").addEventListener("click", () => {\n      taps += 1;\n      navigator.vibrate?.(20);\n      document.getElementById("taps").textContent = taps + (taps === 1 ? " tap" : " taps");\n    });\n  </script>\n</body>\n</html>\n`,
      "manifest.json": `{\n  "name": "My phone app",\n  "short_name": "My app",\n  "start_url": ".",\n  "display": "standalone",\n  "background_color": "#ffffff",\n  "theme_color": "#5A0FC8"\n}\n`,
    },
    run: "",
    requires: null,
    install: { termux: null, debian: null, mac: null, note: "Installable on Android and iPhone from the browser." },
    editor: "HTML",
    blurb: "An installable phone app made with web tech",
  },
  cli("dart", "Dart", "Da", "#0175C2", "mobile", "main.dart",
    `void main() {\n  print('Hello, world!');\n}\n`,
    "dart run main.dart", "dart", { termux: "dart", debian: "dart", mac: "dart-lang/dart/dart" }, "Dart", "The language behind Flutter"),
  cli("kotlin", "Kotlin", "Kt", "#7F52FF", "mobile", "main.kt",
    `fun main() {\n    println("Hello, world!")\n}\n`,
    "kotlinc main.kt -include-runtime -d main.jar 2>/dev/null && java -jar main.jar", "kotlinc", { termux: "kotlin", debian: "kotlin", mac: "kotlin" }, "Kotlin", "Android's language", { aliases: ["android", "kt"] }),
  cli("swift", "Swift", "Sw", "#F05138", "mobile", "main.swift",
    `print("Hello, world!")\n`,
    "swift main.swift", "swift", { termux: "swift", debian: null, mac: null, note: "On macOS, Swift comes with Xcode." }, "Swift", "Apple's language for iOS and macOS", { aliases: ["ios", "apple"] }),

  // ── Systems ──────────────────────────────────────────────────────────────
  cli("zig", "Zig", "Zig", "#F7A41D", "systems", "main.zig",
    `const std = @import("std");\n\npub fn main() void {\n    std.debug.print("Hello, world!\\n", .{});\n}\n`,
    "zig run main.zig", "zig", { termux: "zig", debian: null, mac: "zig" }, "Zig", "A simpler C replacement"),
  cli("nim", "Nim", "Nim", "#FFE953", "systems", "main.nim",
    `echo "Hello, world!"\n`,
    "nim r --hints:off main.nim", "nim", { termux: "nim", debian: "nim", mac: "nim" }, "Nim", "Python-like syntax, C-like speed"),
  cli("crystal", "Crystal", "Cr", "#000100", "systems", "main.cr",
    `puts "Hello, world!"\n`,
    "crystal run main.cr", "crystal", { termux: "crystal", debian: "crystal", mac: "crystal" }, "Crystal", "Ruby-like syntax, compiled"),
  cli("d", "D", "D", "#B03931", "systems", "main.d",
    `import std.stdio;\n\nvoid main() {\n    writeln("Hello, world!");\n}\n`,
    "ldc2 -run main.d", "ldc2", { termux: "ldc", debian: "ldc", mac: "ldc" }, "D", "Modern systems programming"),
  cli("v", "V", "V", "#5D87BF", "systems", "main.v",
    `fn main() {\n\tprintln('Hello, world!')\n}\n`,
    "v run main.v", "v", { termux: null, debian: null, mac: "vlang", note: "Install from vlang.io on Linux." }, "Go", "Simple, fast, compiled"),
  cli("odin", "Odin", "Od", "#3882D2", "systems", "main.odin",
    `package main\n\nimport "core:fmt"\n\nmain :: proc() {\n\tfmt.println("Hello, world!")\n}\n`,
    "odin run main.odin -file", "odin", { termux: null, debian: null, mac: "odin" }, "Go", "Data-oriented systems language"),
  cli("assembly", "Assembly (x86-64 NASM)", "Asm", "#6E4C13", "systems", "main.asm",
    `; Hello world for x86-64 Linux. Phones are ARM, so run this on a PC.\nsection .data\n    msg db "Hello, world!", 10\n    len equ $ - msg\n\nsection .text\n    global _start\n_start:\n    mov rax, 1\n    mov rdi, 1\n    mov rsi, msg\n    mov rdx, len\n    syscall\n    mov rax, 60\n    xor rdi, rdi\n    syscall\n`,
    "nasm -felf64 main.asm -o main.o && ld main.o -o main && ./main", "nasm", { termux: null, debian: "nasm", mac: "nasm", note: "x86-64 Linux only." }, "Gas", "Talk straight to the CPU", { aliases: ["asm", "nasm", "x86"] }),

  // ── JVM & .NET ───────────────────────────────────────────────────────────
  {
    id: "csharp",
    name: "C#",
    abbr: "C#",
    color: "#178600",
    category: "jvm-dotnet",
    aliases: ["csharp", "dotnet", ".net", "cs"],
    kind: "cli",
    entry: "Program.cs",
    files: {
      "Program.cs": `Console.WriteLine("Hello, world!");\n`,
      "app.csproj": `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n`,
    },
    run: "dotnet run",
    requires: "dotnet",
    install: { termux: null, debian: "dotnet-sdk-8.0", mac: "dotnet-sdk" },
    editor: "C#",
    blurb: "Microsoft's .NET language",
  },
  cli("fsharp", "F#", "F#", "#378BBA", "jvm-dotnet", "main.fsx",
    `printfn "Hello, world!"\n`,
    "dotnet fsi main.fsx", "dotnet", { termux: null, debian: "dotnet-sdk-8.0", mac: "dotnet-sdk" }, "F#", "Functional .NET"),
  cli("scala", "Scala", "Sc", "#DC322F", "jvm-dotnet", "main.scala",
    `@main def hello(): Unit =\n  println("Hello, world!")\n`,
    "scala run main.scala", "scala", { termux: null, debian: null, mac: "scala", note: "Install Scala 3 from scala-lang.org." }, "Scala", "Functional and object-oriented on the JVM"),
  cli("groovy", "Groovy", "Gr", "#4298B8", "jvm-dotnet", "main.groovy",
    `println "Hello, world!"\n`,
    "groovy main.groovy", "groovy", { termux: null, debian: "groovy", mac: "groovy" }, "Groovy", "Dynamic JVM scripting"),
  cli("clojure", "Clojure", "Clj", "#5881D8", "jvm-dotnet", "main.clj",
    `(println "Hello, world!")\n`,
    "clojure -M main.clj", "clojure", { termux: null, debian: "clojure", mac: "clojure" }, "Clojure", "A Lisp on the JVM"),

  // ── Scripting & shells ───────────────────────────────────────────────────
  cli("ruby", "Ruby", "Rb", "#CC342D", "scripting", "main.rb",
    `puts "Hello, world!"\n`,
    "ruby main.rb", "ruby", { termux: "ruby", debian: "ruby", mac: "ruby" }, "Ruby", "Friendly, expressive scripting", { popular: true }),
  cli("php", "PHP", "PHP", "#777BB4", "scripting", "main.php",
    `<?php\necho "Hello, world!\\n";\n`,
    "php main.php", "php", { termux: "php", debian: "php-cli", mac: "php" }, "PHP", "Runs much of the web"),
  cli("perl", "Perl", "Pl", "#39457E", "scripting", "main.pl",
    `use strict;\nuse warnings;\n\nprint "Hello, world!\\n";\n`,
    "perl main.pl", "perl", { termux: "perl", debian: "perl", mac: "perl" }, "Perl", "Text processing powerhouse"),
  cli("raku", "Raku", "Ra", "#0298C3", "scripting", "main.raku",
    `say "Hello, world!";\n`,
    "raku main.raku", "raku", { termux: null, debian: "rakudo", mac: "rakudo" }, "Perl", "Perl's modern sibling"),
  cli("lua", "Lua", "Lua", "#000080", "scripting", "main.lua",
    `print("Hello, world!")\n`,
    "lua main.lua", "lua", { termux: "lua54", debian: "lua5.4", mac: "lua" }, "Lua", "Tiny, fast, embeddable"),
  cli("bash", "Bash", "Sh", "#4EAA25", "scripting", "main.sh",
    `#!/usr/bin/env bash\necho "Hello, world!"\necho "Today is $(date +%A)."\n`,
    "bash main.sh", "bash", { termux: "bash", debian: "bash", mac: "bash" }, "Shell", "Automate your device", { aliases: ["shell", "sh", "terminal"], popular: true }),
  cli("zsh", "Zsh", "Zsh", "#89E051", "scripting", "main.zsh",
    `echo "Hello, world!"\n`,
    "zsh main.zsh", "zsh", { termux: "zsh", debian: "zsh", mac: null }, "Shell", "The Z shell"),
  cli("fish", "Fish", "Fsh", "#4AAE47", "scripting", "main.fish",
    `echo "Hello, world!"\n`,
    "fish main.fish", "fish", { termux: "fish", debian: "fish", mac: "fish" }, "Shell", "The friendly interactive shell"),
  cli("powershell", "PowerShell", "PS", "#012456", "scripting", "main.ps1",
    `Write-Output "Hello, world!"\n`,
    "pwsh main.ps1", "pwsh", { termux: null, debian: "powershell", mac: "powershell" }, "PowerShell", "Windows' shell, everywhere"),
  cli("tcl", "Tcl", "Tcl", "#E4CC98", "scripting", "main.tcl",
    `puts "Hello, world!"\n`,
    "tclsh main.tcl", "tclsh", { termux: "tcl", debian: "tcl", mac: "tcl-tk" }, "Tcl", "Tool command language"),
  cli("awk", "AWK", "Awk", "#C30E9B", "scripting", "main.awk",
    `BEGIN { print "Hello, world!" }\n`,
    "awk -f main.awk", "awk", { termux: "gawk", debian: "gawk", mac: "gawk" }, "Shell", "Pattern scanning and processing"),

  // ── Functional ───────────────────────────────────────────────────────────
  cli("haskell", "Haskell", "Hs", "#5E5086", "functional", "main.hs",
    `main :: IO ()\nmain = putStrLn "Hello, world!"\n`,
    "runghc main.hs", "runghc", { termux: "ghc", debian: "ghc", mac: "ghc" }, "Haskell", "Pure functional programming"),
  cli("ocaml", "OCaml", "ML", "#EC6813", "functional", "main.ml",
    `let () = print_endline "Hello, world!"\n`,
    "ocaml main.ml", "ocaml", { termux: "ocaml", debian: "ocaml", mac: "ocaml" }, "OCaml", "Fast, typed functional code"),
  cli("elixir", "Elixir", "Ex", "#6E4A7E", "functional", "main.exs",
    `IO.puts("Hello, world!")\n`,
    "elixir main.exs", "elixir", { termux: "elixir", debian: "elixir", mac: "elixir" }, "Elixir", "Scalable apps on the BEAM"),
  cli("erlang", "Erlang", "Erl", "#B83998", "functional", "main.erl",
    `#!/usr/bin/env escript\nmain(_) ->\n    io:format("Hello, world!~n").\n`,
    "escript main.erl", "escript", { termux: "erlang", debian: "erlang", mac: "erlang" }, "Erlang", "Built for systems that never stop"),
  cli("racket", "Racket", "Rkt", "#3C5CAA", "functional", "main.rkt",
    `#lang racket\n(displayln "Hello, world!")\n`,
    "racket main.rkt", "racket", { termux: null, debian: "racket", mac: "racket" }, "Scheme", "A language for making languages"),
  cli("scheme", "Scheme (Guile)", "Scm", "#1E4AEC", "functional", "main.scm",
    `(display "Hello, world!")\n(newline)\n`,
    "guile main.scm", "guile", { termux: "guile", debian: "guile-3.0", mac: "guile" }, "Scheme", "A minimalist Lisp"),
  cli("commonlisp", "Common Lisp (SBCL)", "CL", "#3FB68B", "functional", "main.lisp",
    `(format t "Hello, world!~%")\n`,
    "sbcl --script main.lisp", "sbcl", { termux: null, debian: "sbcl", mac: "sbcl" }, "Common Lisp", "The programmable programming language", { aliases: ["lisp", "sbcl"] }),
  cli("emacslisp", "Emacs Lisp", "El", "#C065DB", "functional", "main.el",
    `(message "Hello, world!")\n`,
    "emacs --script main.el", "emacs", { termux: "emacs", debian: "emacs-nox", mac: "emacs" }, "Common Lisp", "Script your editor"),

  // ── Data & science ───────────────────────────────────────────────────────
  cli("r", "R", "R", "#276DC3", "data", "main.R",
    `message <- "Hello, world!"\nprint(message)\nprint(summary(c(3, 1, 4, 1, 5, 9, 2, 6)))\n`,
    "Rscript main.R", "Rscript", { termux: null, debian: "r-base-core", mac: "r", note: "On Termux, R comes from the tur-repo." }, "R", "Statistics and charts"),
  cli("julia", "Julia", "Jl", "#9558B2", "data", "main.jl",
    `println("Hello, world!")\n`,
    "julia main.jl", "julia", { termux: null, debian: null, mac: "julia", note: "Install from julialang.org on Linux." }, "Julia", "Fast numerical computing"),
  cli("sql", "SQL (SQLite)", "SQL", "#003B57", "data", "main.sql",
    `CREATE TABLE people (name TEXT, born INTEGER);\nINSERT INTO people VALUES ('Ada', 1815), ('Grace', 1906), ('Alan', 1912);\n.mode table\nSELECT name, born FROM people ORDER BY born;\n`,
    "sqlite3 :memory: < main.sql", "sqlite3", { termux: "sqlite", debian: "sqlite3", mac: "sqlite" }, "SQL", "Query data with SQLite", { aliases: ["sqlite", "database"] }),
  cli("octave", "GNU Octave (MATLAB)", "Oct", "#0790C0", "data", "main.m",
    `disp("Hello, world!")\nA = magic(3)\n`,
    "octave --quiet --no-gui main.m", "octave", { termux: null, debian: "octave", mac: "octave" }, "Octave", "MATLAB-compatible math", { aliases: ["matlab"] }),

  // ── Classic ──────────────────────────────────────────────────────────────
  cli("fortran", "Fortran", "F90", "#734F96", "classic", "main.f90",
    `program hello\n  print *, "Hello, world!"\nend program hello\n`,
    "gfortran main.f90 -o main && ./main", "gfortran", { termux: null, debian: "gfortran", mac: "gcc" }, "Fortran", "Scientific computing since 1957"),
  cli("cobol", "COBOL", "Cob", "#005CA5", "classic", "main.cob",
    `IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO.\nPROCEDURE DIVISION.\n    DISPLAY "Hello, world!".\n    STOP RUN.\n`,
    "cobc -x -free main.cob -o main && ./main", "cobc", { termux: null, debian: "gnucobol", mac: "gnucobol" }, "Cobol", "Still running the banks"),
  cli("pascal", "Pascal", "Pas", "#E3F171", "classic", "main.pas",
    `program Hello;\nbegin\n  writeln('Hello, world!');\nend.\n`,
    "fpc -v0 main.pas -omain >/dev/null && ./main", "fpc", { termux: "fpc", debian: "fp-compiler", mac: "fpc" }, "Pascal", "Structured programming classic"),
  cli("ada", "Ada", "Ada", "#02F88C", "classic", "main.adb",
    `with Ada.Text_IO; use Ada.Text_IO;\nprocedure Main is\nbegin\n   Put_Line ("Hello, world!");\nend Main;\n`,
    "gnatmake -q main.adb && ./main", "gnatmake", { termux: null, debian: "gnat", mac: null }, "Ada", "Built for safety-critical systems"),
  cli("basic", "BASIC", "Bas", "#FF6F00", "classic", "main.bas",
    `10 PRINT "Hello, world!"\n20 END\n`,
    "bwbasic main.bas", "bwbasic", { termux: null, debian: "bwbasic", mac: null }, "VB.NET", "Where many of us started"),
  cli("smalltalk", "Smalltalk (GNU)", "St", "#596706", "classic", "main.st",
    `Transcript showCr: 'Hello, world!'.\n`,
    "gst main.st", "gst", { termux: null, debian: "gnu-smalltalk", mac: "gnu-smalltalk" }, "Smalltalk", "Where objects began"),
  cli("forth", "Forth (Gforth)", "Fth", "#341708", "classic", "main.fs",
    `.( Hello, world!) cr\nbye\n`,
    "gforth main.fs", "gforth", { termux: null, debian: "gforth", mac: "gforth" }, "Forth", "Stack-based and tiny"),
  cli("prolog", "Prolog (SWI)", "Pro", "#E61B23", "classic", "main.pl",
    `:- initialization(main).\nmain :- write('Hello, world!'), nl, halt.\n`,
    "swipl main.pl", "swipl", { termux: "swi-prolog", debian: "swi-prolog", mac: "swi-prolog" }, "Prolog", "Logic programming"),

  // ── Just for fun ─────────────────────────────────────────────────────────
  {
    id: "brainfuck",
    name: "Brainfuck",
    abbr: "BF",
    color: "#2F2F2F",
    category: "esoteric",
    aliases: ["bf", "esolang"],
    kind: "cli",
    entry: "main.bf",
    files: {
      "main.bf": `Prints "Hello World!" with eight characters of language.\n++++++++[>++++[>++>+++>+++>+<<<<-]>+>+>->>+[<]<-]>>.>---.+++++++..+++.>>.<-.<.+++.------.--------.>>+.\n`,
      "bf.js": `// A tiny Brainfuck interpreter so this runs anywhere Node.js does.\nimport { readFileSync } from "node:fs";\n\nconst code = readFileSync(process.argv[2] ?? "main.bf", "utf8").replace(/[^<>+\\-.,[\\]]/g, "");\nconst tape = new Uint8Array(30000);\nlet pointer = 0;\nlet out = "";\nconst jumps = new Map();\nconst stack = [];\nfor (let i = 0; i < code.length; i++) {\n  if (code[i] === "[") stack.push(i);\n  if (code[i] === "]") { const open = stack.pop(); jumps.set(open, i); jumps.set(i, open); }\n}\nfor (let i = 0; i < code.length; i++) {\n  switch (code[i]) {\n    case ">": pointer++; break;\n    case "<": pointer--; break;\n    case "+": tape[pointer]++; break;\n    case "-": tape[pointer]--; break;\n    case ".": out += String.fromCharCode(tape[pointer]); break;\n    case "[": if (!tape[pointer]) i = jumps.get(i); break;\n    case "]": if (tape[pointer]) i = jumps.get(i); break;\n  }\n}\nprocess.stdout.write(out + "\\n");\n`,
    },
    run: "node bf.js main.bf",
    requires: "node",
    install: NODE_INSTALL,
    editor: "Brainfuck",
    blurb: "Eight characters, Turing complete",
  },
];

/** Every language by id. */
export const STUDIO_LANGUAGE_BY_ID: ReadonlyMap<string, StudioLanguage> = new Map(STUDIO_LANGUAGES.map((language) => [language.id, language]));

export function studioLanguage(id: string | null | undefined): StudioLanguage | null {
  return (id && STUDIO_LANGUAGE_BY_ID.get(id)) || null;
}

/** Languages matching a search (name, id, aliases, category, blurb), best matches first. */
export function searchStudioLanguages(query: string, languages: readonly StudioLanguage[] = STUDIO_LANGUAGES): StudioLanguage[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...languages];
  const scored: Array<{ language: StudioLanguage; score: number; index: number }> = [];
  languages.forEach((language, index) => {
    const name = language.name.toLowerCase();
    const haystack = [language.id, name, language.abbr.toLowerCase(), language.category, language.blurb.toLowerCase(), ...language.aliases]
      .join(" ");
    if (!words.every((word) => haystack.includes(word))) return;
    const first = words[0]!;
    const score = name === first || language.id === first || language.aliases.includes(first)
      ? 0
      : name.startsWith(first)
        ? 1
        : 2;
    scored.push({ language, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.language);
}

/** The programming language an editor should use for a file, by extension. */
export function studioEditorLanguageForPath(path: string): string | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "Dockerfile";
  if (name === "makefile") return "Makefile";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return STUDIO_EXTENSION_LANGUAGES[ext] ?? null;
}

const STUDIO_EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX", ts: "TypeScript", tsx: "TSX",
  html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "LESS", json: "JSON", md: "Markdown",
  py: "Python", go: "Go", rs: "Rust", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", java: "Java", kt: "Kotlin",
  kts: "Kotlin", swift: "Swift", rb: "Ruby", php: "PHP", pl: "Perl", raku: "Perl", lua: "Lua", sh: "Shell", bash: "Shell",
  zsh: "Shell", fish: "Shell", ps1: "PowerShell", tcl: "Tcl", awk: "Shell", hs: "Haskell", ml: "OCaml", exs: "Elixir",
  ex: "Elixir", erl: "Erlang", rkt: "Scheme", scm: "Scheme", lisp: "Common Lisp", el: "Common Lisp", clj: "Clojure",
  scala: "Scala", groovy: "Groovy", cs: "C#", fsx: "F#", fs: "Forth", dart: "Dart", zig: "Zig", nim: "Nim", cr: "Crystal",
  d: "D", v: "Go", odin: "Go", asm: "Gas", r: "R", jl: "Julia", sql: "SQL", m: "Octave", f90: "Fortran", cob: "Cobol",
  pas: "Pascal", adb: "Ada", bas: "VB.NET", st: "Smalltalk", bf: "Brainfuck", yaml: "YAML", yml: "YAML", toml: "TOML",
  xml: "XML", svg: "XML", vue: "Vue", svelte: "Svelte", txt: "Plain Text", csproj: "XML",
};
