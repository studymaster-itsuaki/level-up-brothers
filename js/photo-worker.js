/* Level Up Brothers: 画像処理専用Worker。UIスレッドではcanvas処理を行わない。 */
self.onmessage = async event => {
  const { file, targetBytes = 110 * 1024 } = event.data || {};
  if (!file) {
    self.postMessage({ ok: false, error: "画像ファイルがありません。" });
    return;
  }

  let bitmap;
  try {
    if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
      throw new Error("この端末ではバックグラウンド画像処理を利用できません。");
    }

    bitmap = await createImageBitmap(file, {
      resizeWidth: 960,
      resizeQuality: "high",
      imageOrientation: "from-image"
    });

    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    let maxSide = 1200;
    let quality = 0.62;
    let bestBlob = null;
    let bestWidth = sourceWidth;
    let bestHeight = sourceHeight;

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("画像処理用の領域を作成できませんでした。");

      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      canvas.width = 1;
      canvas.height = 1;
      bestBlob = blob;
      bestWidth = width;
      bestHeight = height;

      if (blob.size <= targetBytes) break;
      if (quality > 0.38) quality -= 0.06;
      else maxSide = Math.round(maxSide * 0.86);
    }

    if (!bestBlob || bestBlob.size > 220 * 1024) {
      throw new Error("写真を十分に小さくできませんでした。撮影範囲を狭くしてください。");
    }

    const reader = new FileReaderSync();
    const dataUrl = reader.readAsDataURL(bestBlob);
    self.postMessage({
      ok: true,
      dataUrl,
      bytes: bestBlob.size,
      width: bestWidth,
      height: bestHeight
    });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) });
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
};
