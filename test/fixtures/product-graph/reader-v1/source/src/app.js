export function start(list) {
  return list.map(format);
}
function format(item) {
  return item + process.env.SUFFIX;
}
export function stop() {
  return 1;
}
