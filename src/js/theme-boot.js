(() => {
  try {
    const mirrored = localStorage.getItem("bilipocket.theme");
    const legacy = JSON.parse(localStorage.getItem("bilipocket.prototype.v1") || "null");
    const preference = mirrored || legacy?.settings?.theme || "light";
    const dark =
      preference === "dark" || (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
