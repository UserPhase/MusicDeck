// A tiny canvas sampler keeps the hero in step with whichever artwork a provider supplies.
export function extractArtworkColor(url) {
  return new Promise((resolve) => {
    if (!url || typeof Image === "undefined") {
      resolve(null);
      return;
    }

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 12;
        canvas.height = 12;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0, 12, 12);
        const pixels = context.getImageData(0, 0, 12, 12).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] < 128) continue;
          red += pixels[index];
          green += pixels[index + 1];
          blue += pixels[index + 2];
          count += 1;
        }
        resolve(count ? `${Math.round(red / count)} ${Math.round(green / count)} ${Math.round(blue / count)}` : null);
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
