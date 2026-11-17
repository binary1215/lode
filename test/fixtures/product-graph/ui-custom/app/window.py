"""Synthetic GTK window for the product graph tests. Not a real product."""
from gi.repository import Gtk


class NotesWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title="Notes")
        self.save_button = Gtk.Button(label="Save")
        self.save_button.connect("clicked", self.on_save)
        self.entry = Gtk.Entry()
        self.entry.connect("activate", lambda widget: self.on_save(widget))
        self.connect("destroy", Gtk.main_quit)

    def on_save(self, widget):
        return widget
