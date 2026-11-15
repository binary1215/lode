// Synthetic DOM page script for the product graph tests. Not a real product.
const saveButton = document.getElementById("save");
saveButton.addEventListener("click", saveForm);
document.getElementById("clear").addEventListener("click", () => clearForm());
document.addEventListener("DOMContentLoaded", loadDraft);
store.addEventListener("saved", refreshList);
setInterval(pollStatus, 5000);
// saveButton.addEventListener("click", neverCalled) is a comment, not code.
const note = "saveButton.addEventListener('click', alsoNever)";

function saveForm() {
  store.save();
}

function clearForm() {
  saveButton.disabled = false;
}

function loadDraft() {
  store.load();
}

function refreshList() {
  return note;
}

function pollStatus() {
  store.ping();
}

function bindShortcuts() {
  window.onkeydown = (event) => handleKey(event);
}

function handleKey(event) {
  return event.key;
}
