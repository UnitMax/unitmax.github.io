const games = [
  {
    title: "Pure Pour",
    genre: "Interactive Puzzle",
    url: "./games/pure-pour/",
    artHue: 196,
  },
  {
    title: "Infinite Mandelbrot Set",
    genre: "Infinite-Zoom GPU Visualizer",
    url: "./games/mandelbrot/",
    artHue: 236,
  },
  {
    title: "Coming Soon",
    genre: "t.b.d.",
    url: "#",
    artHue: 288,
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
    title: "PictBake",
    genre: "Chrome Extension",
    description:
      "Privacy-friendly image conversion for turning WebP files into PNG or JPEG directly in Chrome, offline and without sending anything to external services.",
    url: "https://github.com/UnitMax/PictBake",
    artHue: 204,
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

function setupSectionViews() {
  const links = Array.from(document.querySelectorAll(".side-nav-link"));
  const homeLink = document.querySelector(".brand[data-target='home']");
  const views = Array.from(document.querySelectorAll(".hero, .section"));
  if (!links.length || !views.length) return;

  const viewById = new Map(views.map((view) => [view.id, view]));
  const viewLinks = Array.from(document.querySelectorAll("a[href^='#']")).filter(
    (link) => viewById.has(link.dataset.target || link.hash.replace("#", ""))
  );

  const getRequestedView = () => {
    const id = window.location.hash.replace("#", "");
    return viewById.has(id) ? id : "home";
  };

  const setActive = (id) => {
    links.forEach((link) =>
      link.classList.toggle("is-active", link.dataset.target === id)
    );
    homeLink?.classList.toggle("is-active", id === "home");
  };

  const showView = (id, options = {}) => {
    const nextId = viewById.has(id) ? id : "home";
    views.forEach((view) => {
      const isActive = view.id === nextId;
      view.hidden = !isActive;
      view.classList.toggle("is-active-view", isActive);
      if (isActive) view.classList.add("is-shown");
    });
    setActive(nextId);

    if (options.updateUrl !== false) {
      const nextUrl =
        nextId === "home"
          ? `${window.location.pathname}${window.location.search}`
          : `#${nextId}`;
      history.pushState({ view: nextId }, "", nextUrl);
    }

    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, 0);
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
  };

  viewLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showView(link.dataset.target || link.hash.replace("#", ""));
    });
  });

  window.addEventListener("popstate", () => {
    showView(getRequestedView(), { updateUrl: false });
  });

  showView(getRequestedView(), { updateUrl: false });
}

function setupReveal() {
  const targets = document.querySelectorAll(".section");
  targets.forEach((el) => el.classList.add("reveal"));
}

renderCards("games-grid", games, "game");
renderCards("projects-grid", projects, "project");
setupReveal();
setupSectionViews();
