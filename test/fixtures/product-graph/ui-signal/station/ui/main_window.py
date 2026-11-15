"""Synthetic Qt window for the product graph tests. Not a real product."""
from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QCheckBox, QDialog, QMainWindow, QPushButton


class StatusModel(QObject):
    changed = Signal()

    def refresh(self):
        self.changed.emit()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.model = StatusModel()
        self.save_button = QPushButton("Save")
        self.save_button.clicked.connect(self._save)
        self.reset_button = QPushButton("Reset")
        self.reset_button.clicked.connect(lambda: self._reset_view())
        self.verbose_check = QCheckBox("Details")
        self.verbose_check.toggled.connect(self._toggle_details)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._poll)
        self.model.changed.connect(self._render)
        help_button = QPushButton("Help")
        help_button.clicked.connect(lambda: print("help"))
        self.destroyed.connect(self._forget)
        # self.hidden_button.clicked.connect(self._never) is a comment, not code.
        self.note = "self.fake_button.clicked.connect(self._fake)"

    def _save(self):
        self.model.refresh()

    def _reset_view(self):
        self.verbose_check.setChecked(False)

    def _toggle_details(self, checked):
        self.note = str(checked)

    def _poll(self):
        self.model.refresh()

    def _forget(self):
        self.note = ""

    def _render(self):
        self.note = "rendered"

    def closeEvent(self, event):
        self.timer.stop()
        event.accept()


class ExportDialog(QDialog):
    """Nothing in this product opens this dialog."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.ok_button = QPushButton("OK")
        self.ok_button.clicked.connect(self.accept)
