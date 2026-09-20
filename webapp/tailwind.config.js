/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: "var(--accent)",
        surface: {
          app: "var(--bg-app)",
          panel: "var(--bg-panel)",
          card: "var(--bg-card)",
        },
        glass: {
          border: "var(--border-glass)",
        },
        command: {
          app: "#09090B",
          panel: "#120C1A",
          violet: "#A855F7",
        },
      },
    },
  },
  plugins: [],
};
