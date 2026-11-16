# Code-driven user filters

As a font grows, browsing every glyph by hand is a poor way to do targeted QA. Filters let Overview show exactly the subset you care about, including custom Python loaded from your Filters folder.

Built-in filters cover common cases. Custom filters are Python files in the settings folder in `Counterpunch/Filters`. Apply a built-in filter first so you can see the list change, then try a custom script.

**Categories** sorts glyphs by their Unicode category into Letters, Modifiers (spacing accents such as ˆ), Marks, Figures, Punctuation, Symbols and Spaces & Controls. Only the categories that the font uses are shown. Glyphs such as `a.sc` count with their base glyph `a`. **No Category** collects the glyphs that Counterpunch’s glyph data doesn’t know, such as many Arabic dot marks and ligatures.

Click a filter to show only its glyphs. Shift-click or `Cmd/Ctrl`-click another filter to combine the two, and again to remove it. Filters in **Categories** add up: Letters and Marks show both. All other filters narrow the result: Letters and **Auto QA Issues** show only letters with warnings. The filter you clicked last gives the tiles their colors and fills the group legend.

A filter only classifies glyphs. It must not edit the font. If a filter errors, read the first line of the message, check syntax and the expected API, fix one thing, and run it again.

The contract for writing a filter is in [Writing glyph overview filters](../python/05-writing-glyph-overview-filters.md). Python setup is in [Python in Counterpunch](../python/01-python-in-counterpunch.md). Recovery notes are in [Common problems](../troubleshooting/common-problems.md).
