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
];

function renderCards(gridId, items) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  grid.innerHTML = items
    .map(
      (item) => `
      <article class="game-card">
        <div class="game-art" style="--art-hue:${item.artHue};" aria-hidden="true"></div>
        <div class="game-content">
          <h3 class="game-title">${item.title}</h3>
          <p class="game-meta">${item.genre}</p>
          ${item.description ? `<p class="game-description">${item.description}</p>` : ""}
          <a class="game-link" href="${item.url}" aria-label="View ${item.title} details">
            View More
          </a>
        </div>
      </article>
    `
    )
    .join("");
}

function setupSectionTabs() {
  const tabs = Array.from(document.querySelectorAll(".nav-tab"));
  const sections = Array.from(document.querySelectorAll(".portfolio-shell > section"));
  if (!tabs.length || !sections.length) return;

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const sectionId = tab.dataset.section;
      if (!sectionId) return;

      tabs.forEach((node) => node.classList.toggle("is-active", node === tab));

      sections.forEach((section) => {
        const isTarget = section.id === sectionId;
        section.hidden = !isTarget;
        section.classList.toggle("is-open", isTarget);
      });
    });
  });
}

renderCards("games-grid", games);
renderCards("projects-grid", projects);
setupSectionTabs();
