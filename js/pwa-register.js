(() => {
  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    });

    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", {
        scope: "./",
        updateViaCache: "none"
      });
      await registration.update();
    } catch (error) {
      console.warn("Service Workerを登録できませんでした。", error);
    }
  });
})();
