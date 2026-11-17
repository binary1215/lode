"""Synthetic Tk tool for the product graph tests. Not a real product."""
import tkinter as tk


class CalibrateWindow:
    def __init__(self, root):
        self.root = root
        self.start_button = tk.Button(root, text="Start", command=self.start)
        self.stop_button = tk.Button(root, text="Stop", command=lambda: self.stop())
        self.canvas = tk.Canvas(root)
        self.canvas.bind("<Button-1>", self.mark)
        self.root.bind("<Configure>", self.relayout)
        self.root.after(500, self.tick)

    def start(self):
        self.tick()

    def stop(self):
        self.root.quit()

    def mark(self, event):
        self.canvas.create_oval(event.x, event.y, event.x + 2, event.y + 2)

    def relayout(self, event):
        self.canvas.config(width=event.width)

    def tick(self):
        self.root.after(500, self.tick)
