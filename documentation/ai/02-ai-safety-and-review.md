# Safety and review

Treat assistant output as something you authorized with the pen toggle, not as an unsupervised design pass. The assistant does not save files. With **Assistant editing** off, it cannot mutate the font or rewrite the Script Editor. With editing on, Python it executes can change the font immediately, and Script Editor buffer edits still wait for you to Save or Run.

Before a broad operation, save the font and turn editing on only for that prompt. Confirm whether the task should inspect, draft a script, or change data. Name glyph ranges, layers, axis values, or naming patterns.

While Assistant is focused, `Cmd/Ctrl+Z` undoes assistant-produced font edits on the automation undo surface without switching views. Script Editor buffer edits can be reverted from the chat action when the buffer has not changed since, or from the Script Editor recovery controls.

Ask for one change at a time. If the result is wrong, undo, then tighten the prompt. You can still ask it to explain the intended change before it writes code.

The assistant sends your prompt and a compact editor-state summary to the AI service, not a complete font file. Cloud fonts are stored separately when you Save As to Cloud or accept an invite. See [Cloud fonts](../files/05-cloud-fonts.md) and Help → Privacy Policy in the editor.

Related: [AI assistant](01-ai-assistant-overview.md), [Script editor](../python/02-script-editor-workflow.md).
