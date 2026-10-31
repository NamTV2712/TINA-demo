(function (scope) {
  function clock(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const tail = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return hours ? `${hours}:${tail}` : tail;
  }

  function appLabel(apps) {
    if (!apps || !apps.length) return "Cuộc họp";
    if (apps.length === 1) return apps[0].name || "Cuộc họp";
    return `${apps[0].name || "Cuộc họp"} +${apps.length - 1}`;
  }

  scope.TinaOverlayUtils = Object.freeze({ clock, appLabel });
})(globalThis);
