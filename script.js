const games = [
  {
    title: "Pure Pour",
    genre: "Interactive Puzzle",
    url: "./games/pure-pour/",
    artHue: 196,
  },
  {
    title: "Coming Soon",
    genre: "t.b.d.",
    url: "#",
    artHue: 288,
  },
  {
    title: "Coming Soon",
    genre: "t.b.d.",
    url: "#",
    artHue: 236,
  },
  {
    title: "Coming Soon",
    genre: "t.b.d.",
    url: "#",
    artHue: 158,
  },
];

const projects = [
  {
    title: "LostButtonFoundry",
    genre: "Chrome Extension",
    description:
      "Open-source Chrome tweaks that add missing Google Maps shortcuts: send selected webpage text to Maps from the context menu, or open a Google Search query in Maps from a new button beside the search box.",
    url: "https://github.com/UnitMax/LostButtonFoundry",
    artHue: 126,
  },
  {
    title: "SnipCaddy",
    genre: "Windows Screenshot Utility",
    description:
      "A tray-first, fully private C# / WPF screenshot caddy for fast region captures, clipboard-ready PNGs, a floating stack, drag-and-drop handoff, and built-in annotation or redaction without sending anything to the cloud.",
    url: "https://github.com/UnitMax/SnipCaddy",
    artHue: 24,
  },
];

function renderCards(gridId, items, kind) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  const tag = kind === "game" ? "Game" : "Project";

  grid.innerHTML = items
    .map((item) => {
      const isPlaceholder = !item.url || item.url === "#";
      const isExternal = /^https?:/i.test(item.url || "");
      const ctaText = isPlaceholder
        ? "Coming soon"
        : isExternal
        ? "Visit"
        : "Launch";

      const inner = `
        <div class="card-art" style="--art-hue:${item.artHue};" aria-hidden="true">
          <span class="card-tag">${tag}</span>
        </div>
        <div class="card-body">
          <h4 class="card-title">${item.title}</h4>
          <p class="card-meta">${item.genre}</p>
          ${item.description ? `<p class="card-desc">${item.description}</p>` : ""}
          <span class="card-cta">
            <span>${ctaText}</span>
            <span class="card-cta-arrow" aria-hidden="true">↗</span>
          </span>
        </div>
      `;

      if (isPlaceholder) {
        return `<article class="card is-disabled" aria-disabled="true">${inner}</article>`;
      }

      const target = isExternal ? ' target="_blank" rel="noopener"' : "";
      return `<a class="card" href="${item.url}"${target} aria-label="${item.title}">${inner}</a>`;
    })
    .join("");

  const countEl = document.querySelector(`[data-count-for="${gridId}"]`);
  if (countEl) {
    const n = String(items.length).padStart(2, "0");
    countEl.textContent = `[ ${n} ${items.length === 1 ? "item" : "items"} ]`;
  }
}

function buildDialBezel() {
  const svg = document.querySelector(".dial-bezel");
  if (!svg) return;
  const ns = "http://www.w3.org/2000/svg";
  const total = 60;
  const fragments = [];
  for (let i = 0; i < total; i++) {
    const angle = (i / total) * 360;
    const isMajor = i % 5 === 0;
    const isCardinal = i % 15 === 0;
    const r1 = 96;
    const r2 = isCardinal ? 80 : isMajor ? 86 : 91;
    const rad = ((angle - 90) * Math.PI) / 180;
    const x1 = (Math.cos(rad) * r1).toFixed(2);
    const y1 = (Math.sin(rad) * r1).toFixed(2);
    const x2 = (Math.cos(rad) * r2).toFixed(2);
    const y2 = (Math.sin(rad) * r2).toFixed(2);
    const w = isCardinal ? 1.6 : isMajor ? 1.1 : 0.6;
    const opacity = isCardinal ? 0.9 : isMajor ? 0.65 : 0.35;
    fragments.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${w}" opacity="${opacity}"/>`
    );
  }
  fragments.push(
    `<circle cx="0" cy="0" r="96" fill="none" stroke="currentColor" stroke-width="0.4" opacity="0.25"/>`
  );
  svg.innerHTML = fragments.join("");
  svg.setAttribute("xmlns", ns);
}

function setupScrollSpy() {
  const links = Array.from(document.querySelectorAll(".topnav-link"));
  const sections = links
    .map((link) => document.getElementById(link.dataset.target))
    .filter(Boolean);
  if (!links.length || !sections.length) return;

  const setActive = (id) => {
    links.forEach((link) =>
      link.classList.toggle("is-active", link.dataset.target === id)
    );
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible.length) setActive(visible[0].target.id);
    },
    {
      rootMargin: "-45% 0px -50% 0px",
      threshold: [0, 0.25, 0.5, 0.75, 1],
    }
  );

  sections.forEach((s) => observer.observe(s));
}

function setupReveal() {
  const targets = document.querySelectorAll(".section");
  targets.forEach((el) => el.classList.add("reveal"));

  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-shown");
          obs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  targets.forEach((el) => obs.observe(el));
}

renderCards("games-grid", games, "game");
renderCards("projects-grid", projects, "project");
buildDialBezel();
setupScrollSpy();
setupReveal();
