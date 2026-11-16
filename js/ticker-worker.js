// A steady clock that keeps running when the page is in a background tab
// (browsers pause requestAnimationFrame there). Used on laptops so monitoring
// continues while you work in another window.
let timer = null;
onmessage = (e) => {
  clearInterval(timer);
  timer = e.data > 0 ? setInterval(() => postMessage(0), e.data) : null;
};
