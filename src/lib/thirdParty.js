import * as d3 from "d3";

export async function installThirdPartyGlobals() {
  window.d3 = d3;

  const [lmResult, gsdResult] = await Promise.allSettled([
    import("ml-levenberg-marquardt"),
    import("ml-gsd"),
  ]);

  if (lmResult.status === "fulfilled") {
    const mod = lmResult.value;
    window.levenbergMarquardt = mod.default || mod.levenbergMarquardt || mod;
  } else {
    console.warn("Levenberg-Marquardt failed to load:", lmResult.reason);
  }

  if (gsdResult.status === "fulfilled") {
    const mod = gsdResult.value;
    window.gsd = mod.gsd || mod.default || mod;
  } else {
    console.warn("ml-gsd failed to load:", gsdResult.reason);
  }
}
