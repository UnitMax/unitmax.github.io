const games = [
  {
    title: "Pure Pour",
    genre: "Interactive Puzzle",
    url: "#",
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

function renderGames() {
  const gamesGrid = document.getElementById("games-grid");
  if (!gamesGrid) return;

  gamesGrid.innerHTML = games
    .map(
      (game) => `
      <article class="game-card">
        <div class="game-art" style="--art-hue:${game.artHue};" aria-hidden="true"></div>
        <div class="game-content">
          <h3 class="game-title">${game.title}</h3>
          <p class="game-meta">${game.genre}</p>
          <a class="game-link" href="${game.url}" aria-label="View ${game.title} details">
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
  const sections = Array.from(document.querySelectorAll(".section-panel"));
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

renderGames();
setupSectionTabs();
