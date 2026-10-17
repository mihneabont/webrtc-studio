"""Studio Mixer: the native (GStreamer) mixing engine controlled from the studio page."""

# With the GStreamer wheels from PyPI (`pip install gstreamer-bundle`, used on Windows) the libraries,
# plugins and the `gi` bindings live inside the venv and must be put on the paths before `import gi`.
# A system GStreamer (apt, brew) has no gstreamer_libs module and needs nothing here.
try:
    import gstreamer_libs as _gst_wheels
except ImportError:
    pass
else:
    _gst_wheels.setup_python_environment()
__version__ = "0.1.0"
