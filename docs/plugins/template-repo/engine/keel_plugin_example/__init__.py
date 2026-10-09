"""Example: the engine part. keel imports this package when it starts and reads ADDON."""

VERSION = "0.1.0"   # the same version as keel-plugin.yml

ADDON = {
    "name": "example",
    "title": "Example",
    "version": VERSION,
    "actions": {},     # "example:do": a function, for workflow steps
}
