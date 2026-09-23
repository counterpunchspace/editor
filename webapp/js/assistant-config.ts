/**
 * Assistant configuration: tool definitions and system prompt.
 * Lives in the editor webapp and is sent to the server with each API request.
 * This keeps configuration in the editor codebase where new tools can be added
 * as the assistant's capabilities expand (e.g. editing Python files directly).
 */

export interface UsageMetrics {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    total_cost?: number;
    cost_eur_cents?: number;
}

export type AssistantTool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type AssistantToolCategory =
    | 'Documentation'
    | 'Font Files'
    | 'Editor'
    | 'OpenType'
    | 'Binary Font'
    | 'Python'
    | 'Conversation';

/** Categories for displaying the assistant tool catalog without changing API tool payloads. */
export const ASSISTANT_TOOL_CATEGORIES: Readonly<
    Record<string, AssistantToolCategory>
> = {
    handbook_toc: 'Documentation',
    handbook_topic: 'Documentation',
    python_api_docs: 'Documentation',
    list_available_fonts: 'Font Files',
    open_font: 'Font Files',
    current_font: 'Font Files',
    execute_python_code: 'Python',
    get_editor_state: 'Editor',
    get_font_opentype_info: 'OpenType',
    search_font_opentype_classes_and_features: 'OpenType',
    set_editor_text_buffer: 'Editor',
    set_editor_opentype_features: 'Editor',
    compile_binary_font: 'Binary Font',
    shape_binary_font: 'Binary Font',
    binary_font_api_docs: 'Documentation',
    describe_binary_font: 'Binary Font',
    list_binary_font_children: 'Binary Font',
    search_binary_font_surface: 'Binary Font',
    search_binary_font_children: 'Binary Font',
    snapshot_binary_font: 'Binary Font',
    inspect_binary_font: 'Binary Font',
    get_active_python_document: 'Python',
    python_authoring_guide: 'Documentation',
    glyph_filter_event_types: 'Documentation',
    list_python_files: 'Python',
    search_python_files: 'Python',
    read_python_file: 'Python',
    open_python_document_in_editor: 'Python',
    create_python_draft_in_editor: 'Python',
    replace_python_text_in_editor: 'Python',
    validate_python_document: 'Python',
    set_prompt_history_summary: 'Conversation'
};

export const ASSISTANT_TOOLS: AssistantTool[] = [
    {
        type: 'function',
        function: {
            name: 'handbook_toc',
            description:
                'Get the full table of contents of the Counterpunch user handbook. This lists all available documentation topics organized by section. Each page includes a docs:// link token (for example docs://editor/outline-drawing). Use this first to discover what handbook topics are available. When citing a handbook page for the user in markdown, link with that docs:// token so the in-app docs viewer opens.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'handbook_topic',
            description:
                'Get the full content of a specific documentation page from the Counterpunch user handbook. Use handbook_toc first to discover available topics.',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        description:
                            'Handbook page id, docs:// link, or path, e.g. "getting-started/before-you-begin", "docs://getting-started/before-you-begin", or "python/04-writing-general-scripts.md"'
                    }
                },
                required: ['topic']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'python_api_docs',
            description:
                'Get the complete Python API documentation for the font editing model. Includes all classes, methods, and properties available for scripting font operations. Glyph.qa is the quality-assurance message list (Auto QA and future plugin checks).',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_available_fonts',
            description:
                'List all available fonts across all file storage plugins (memory, disk, cloud). Returns the full URL for each font, including the plugin prefix (e.g. memory:///user/Fustat.glyphs). Use this to discover which fonts the user can open.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'open_font',
            description:
                'Open a font by its full URL (e.g. memory:///user/Fustat.glyphs). Use list_available_fonts first to get valid URLs. Shows a loading spinner while the font opens.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description:
                            'Full font URL including plugin prefix, e.g. memory:///user/Fustat.glyphs or cloud://abc-123'
                    }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'current_font',
            description:
                'Get the currently open font details. Returns the font name and URL in the same format as list_available_fonts. Use this before open_font to avoid reopening an already-open font.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_python_code',
            description:
                "Execute Python to read or modify the current font. Call python_api_docs first for unfamiliar APIs. Font() is preloaded. Inspect with print() on specific fields (print(master.name.dflt), print(master.location)); do not serialize the whole font to JSON to read one field. For quality-assurance messages, read glyph.qa (list of dicts with sourceId, severity, checkId, message, messageId; built-in Auto QA uses sourceId 'auto-qa'). Changes to the font model are automatically tracked and compiled.",
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'The Python code to execute.'
                    }
                },
                required: ['code']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_editor_state',
            description:
                'Get the current editor state for both inspection and parameter-copying. Returns the active glyph name (null in text mode when no glyph is being edited), the text-run caret as cursorPosition (logical index into textBufferRaw; 0 is before the first character), raw text-buffer syntax as textBuffer and textBufferRaw, user-visible text as textBufferDisplay, parsed explicit glyph tokens, HarfBuzz shaped buffers (glyph names, gids, advances, clusters), OpenType feature inventory, userspace/designspace location, and the current file. OpenType features: every listed feature exists in the font. Features with availableToActivate true are reachable in the current editing subset (determined by the text buffer and active feature set) and can be turned on/off now. Features with availableToActivate false still exist, but are greyed out in the sidebar because the current subset cannot reach them yet; explain that to the user and recommend enabling them with set_editor_opentype_features when their effect is wanted. Read opentypeFeaturesExplanation and each feature status/note in the tool output for the plain-language breakdown. In raw text syntax, // represents one literal slash and /glyphname is an explicit glyph reference only when it resolves; never claim an escaped slash pair unless textBufferRaw explicitly contains //. Refresh this state after text, feature, or font-data edits.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_font_opentype_info',
            description:
                'Explain how OpenType shaping depends on script-specific shaper execution order for the current font. Reports the explicit feature source order as defined in the font, clarifies that source order is not shaping order, and then reproduces the shaper-specific feature sections shown in the features sidebar for every shaper currently in use. Reordering user-sortable (discretionary) features can change the shaping outcome, so their order is critical.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_font_opentype_classes_and_features',
            description:
                "Search the current font's OpenType classes and features using the same term-based matching logic as the search field in the OpenType editor sidebar. Returns matching class names, glyph names, and lines of feature code. Feature matches are reported with the feature source-order index and the matching line numbers within each feature. If you want to see the entire content of a certain feature, it is better to read it via Python, as `search_font_opentype_classes_and_features` will only match glyph names in classes as well as glyphs names and class names in features.",
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description:
                            'Search query, split into space-separated search terms just like the OpenType editor search field. Example: "grave" or "grave @marks".'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_editor_text_buffer',
            description:
                'Set the raw text-buffer contents. The string may include encoded Unicode characters, literal slashes encoded as //, and explicit glyph names using the /glyphname notation. Several glyph names may appear consecutively, but the last one needs to have a space character as a suffix before encoded characters may follow. Use tool `get_editor_state` first to inspect textBufferRaw, textBufferDisplay, and explicitGlyphTokens.',
            parameters: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description:
                            'The new raw text buffer content. Use // for one literal slash and /glyphname for an explicit glyph reference. Example: "H/Ohorn/e/l/l/o", "ABC /fi /ffi def", or "0//10" for the visible text 0/10.'
                    }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_editor_opentype_features',
            description:
                'Set which OpenType features are activated. Provide a list of feature tags to enable; all other features are set to false. Use get_editor_state first. Prefer tags with availableToActivate true when you need an immediate visible effect. If a needed feature has availableToActivate false, it still exists in the font but is not reachable in the current subset yet — explain that, then include it in the enable list so it can become active.',
            parameters: {
                type: 'object',
                properties: {
                    features: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Array of OpenType feature tags to enable (e.g. ["liga", "kern", "dlig"]). All features not in this list will be disabled.'
                    }
                },
                required: ['features']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'compile_binary_font',
            description:
                'Compile the current committed font in an isolated analysis worker and return only a stable fontHash. The hash is always 16 hex digits; it is not a glyph count. Target full compiles every glyph. Target subset requires text and compiles the layout closure of that text. The tool is read-only for the editor, waits for committed worker state, is unavailable during an active edit preview, and never exposes binary bytes. Pass the returned fontHash explicitly to the other binary-font tools; they never compile implicitly.',
            parameters: {
                type: 'object',
                properties: {
                    target: {
                        type: 'string',
                        enum: ['full', 'subset'],
                        description:
                            'Optional compile target. Defaults to full, which compiles every glyph. Use subset together with text to compile the layout closure of that text.'
                    },
                    text: {
                        type: 'string',
                        description:
                            'Text used to derive the subset closure when target is subset.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'shape_binary_font',
            description:
                'Shape explicit text with a previously compiled binary font hash. Requires fontHash from compile_binary_font. This tool only reads the isolated analysis cache, never recompiles, and never changes editor state. features is an optional JSON feature map such as {"liga": false, "kern": true}; variationLocation is an optional userspace axis-value object such as {"wght": 500}.',
            parameters: {
                type: 'object',
                properties: {
                    fontHash: {
                        type: 'string',
                        description:
                            'Required stable hash returned by compile_binary_font.'
                    },
                    text: {
                        type: 'string',
                        description: 'Required text to shape.'
                    },
                    features: {
                        type: 'object',
                        description:
                            'Optional HarfBuzz feature map, for example {"liga": false, "kern": true}.'
                    },
                    variationLocation: {
                        type: 'object',
                        description:
                            'Optional userspace variation location, for example {"wght": 500}.'
                    }
                },
                required: ['fontHash', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'binary_font_api_docs',
            description:
                'Get the supported binary-font discovery, shaping, and inspection workflow, path grammar, profile meanings, result format, and safety limits. Use this before inspect_binary_font when you need exact leaf paths. Use describe_binary_font, search_binary_font_surface, list_binary_font_children, search_binary_font_children, or snapshot_binary_font while you are still discovering the font structure.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'describe_binary_font',
            description:
                'Describe the supported binary-font path families, child collections, and snapshot profiles. This is static guidance only and does not require a fontHash.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Optional path prefix to focus the description on a subtree, such as "/tables/name" or "/tables/fvar".'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_binary_font_children',
            description:
                'List the immediate children of one supported binary-font collection path in a compiled font. Requires a fontHash and a collection path such as /tables/name/records or /tables/fvar/axes.',
            parameters: {
                type: 'object',
                properties: {
                    fontHash: {
                        type: 'string',
                        description:
                            'Required stable hash returned by compile_binary_font.'
                    },
                    path: {
                        type: 'string',
                        description:
                            'Required collection path, such as "/tables/name/records" or "/tables/fvar/axes".'
                    },
                    fontIndex: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'Optional face index for a TrueType Collection. Defaults to 0.'
                    },
                    limit: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'Optional upper bound on how many children to return. Defaults to the tool limit.'
                    }
                },
                required: ['fontHash', 'path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_binary_font_surface',
            description:
                'Search the static binary-font surface metadata, path families, and snapshot profiles by keyword. Use this when you are still discovering the tool surface and do not yet have a fontHash.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description:
                            'Search text or fragment, such as "nameID=1", "variation", or "advanceWidth".'
                    },
                    path: {
                        type: 'string',
                        description:
                            'Optional static path prefix, such as "/tables/name" or "/tables/fvar", to narrow the search.'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_binary_font_children',
            description:
                'Search actual child entries inside one compiled-font subtree. Requires fontHash and a collection path. Use this after list_binary_font_children or when you already know the subtree you want to inspect.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description:
                            'Search text or fragment to match against the returned child entries.'
                    },
                    fontHash: {
                        type: 'string',
                        description:
                            'Required stable hash returned by compile_binary_font.'
                    },
                    path: {
                        type: 'string',
                        description:
                            'Required collection path to search, such as "/tables/name/records" or "/tables/fvar/axes".'
                    },
                    fontIndex: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'Optional face index for a TrueType Collection. Defaults to 0.'
                    },
                    limit: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'Optional upper bound on how many child entries to search. Defaults to the tool limit.'
                    }
                },
                required: ['query', 'fontHash', 'path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'snapshot_binary_font',
            description:
                'Return one curated binary-font snapshot bundle. Use this when you want a practical bundle of the most relevant font data without manually assembling leaf paths. The available profiles are summary, names, variation, metrics, review, and full.',
            parameters: {
                type: 'object',
                properties: {
                    fontHash: {
                        type: 'string',
                        description:
                            'Required stable hash returned by compile_binary_font.'
                    },
                    profile: {
                        type: 'string',
                        enum: [
                            'summary',
                            'names',
                            'variation',
                            'metrics',
                            'review',
                            'full'
                        ],
                        description:
                            'Snapshot profile. summary is the smallest bundle; full is the broadest bundle.'
                    },
                    fontIndex: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'Optional face index for a TrueType Collection. Defaults to 0.'
                    }
                },
                required: ['fontHash']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'inspect_binary_font',
            description:
                'Inspect exact OpenType leaf values from a previously compiled binary font hash. Requires fontHash from compile_binary_font and is best used after describe_binary_font, list_binary_font_children, or search_binary_font_children has identified the exact leaf paths you want. This tool never compiles implicitly. Paths are resolved in request order and returned as {values: [...]}; missing optional values are null and malformed fonts or exceeded safety limits fail visibly.',
            parameters: {
                type: 'object',
                properties: {
                    fontHash: {
                        type: 'string',
                        description:
                            'Required stable hash returned by compile_binary_font.'
                    },
                    fontIndex: {
                        type: 'integer',
                        minimum: 0,
                        description:
                            'Optional face index for a TrueType Collection. Defaults to 0.'
                    },
                    paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Required bounded list of exact supported leaf paths. Values preserve this exact order.'
                    }
                },
                required: ['fontHash', 'paths']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_active_python_document',
            description:
                'Read the current Script Editor buffer. This is the first call before editing an existing Python document. It returns saved path, revision, modified state, optionally bounded content, and Python kind classification fields. For an unsaved buffer, kind can be null and editorKind may only be the editor fallback; inspect kindConfidence and kindMessage before choosing python_authoring_guide. This only reads the buffer; it never runs or saves Python.',
            parameters: {
                type: 'object',
                properties: {
                    include_content: { type: 'boolean' },
                    max_chars: { type: 'number' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'python_authoring_guide',
            description:
                'Retrieve the full authoring guide directly for one Python document kind; handbook discovery is not required. After choosing a kind, call this before creating or substantially editing Python. The guide explains the required structure and purpose for that kind. This only reads documentation; it never runs or saves code.',
            parameters: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        enum: ['general-script', 'glyph-filter'],
                        description:
                            'Choose general-script for a reusable Counterpunch/Scripts file that the user runs from Script Editor. Choose glyph-filter for a Counterpunch/Filters file that Glyph Overview uses to select glyphs. The Assistant never runs either kind or selects a filter.'
                    }
                },
                required: ['kind']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'glyph_filter_event_types',
            description:
                'Return the central Glyph Overview event list and the simple filter contract. Call this before authoring or substantially editing a glyph filter. Filters require literal EVENT_TYPES and classify_glyph(glyph); is_candidate(glyph) is optional. Never write filter_glyphs, apply_changes, GROUPS, glyph.created, glyph.deleted, glyph.renamed, or font.masters.changed.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_python_files',
            description:
                'List saved managed Python files in Counterpunch/Scripts, Counterpunch/Filters, or both. Use this to find a saved file before read_python_file or open_python_document_in_editor. This cannot see an unsaved Script Editor buffer and never runs a script.',
            parameters: {
                type: 'object',
                properties: {
                    collection: {
                        type: 'string',
                        enum: ['scripts', 'filters', 'both'],
                        description:
                            'Choose scripts for reusable general scripts, filters for Glyph Overview filters, or both for both managed collections.'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_python_files',
            description:
                'Search file names and text in saved managed Python files. Returns concise matching lines and paths that can be passed to read_python_file or open_python_document_in_editor. This cannot search an unsaved Script Editor buffer and never runs a script.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    collection: {
                        type: 'string',
                        enum: ['scripts', 'filters', 'both'],
                        description:
                            'Choose scripts for reusable general scripts, filters for Glyph Overview filters, or both for both managed collections.'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_python_file',
            description:
                'Read a 1-based inclusive line range from a saved managed Python file. Use a path returned by list_python_files or search_python_files. For the unsaved Script Editor buffer, use get_active_python_document instead. This only reads a file; it never opens, runs, or saves it.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Path returned by list_python_files or search_python_files.'
                    },
                    start_line: {
                        type: 'number',
                        description:
                            'Optional first 1-based line to return. Defaults to the file start.'
                    },
                    end_line: {
                        type: 'number',
                        description:
                            'Optional last 1-based line to return, inclusive.'
                    }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'open_python_document_in_editor',
            description:
                'Open a saved managed Python file in the Script Editor for the user. Use a path returned by list_python_files or search_python_files. Opening makes it the active buffer but does not execute or save the file.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'Path returned by list_python_files or search_python_files.'
                    }
                },
                required: ['path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_python_draft_in_editor',
            description:
                'Create a new unsaved Script Editor buffer. For a new document, choose the kind from the user request, call python_authoring_guide for that kind, then create the draft. Requires Assistant editing to be enabled. After creation, read the active document and validate it. This never saves or runs code.',
            parameters: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        enum: ['general-script', 'glyph-filter'],
                        description:
                            'general-script is a reusable Counterpunch/Scripts file. glyph-filter is a Counterpunch/Filters Glyph Overview filter.'
                    },
                    content: {
                        type: 'string',
                        description:
                            'Optional initial Python source for the unsaved buffer.'
                    }
                },
                required: ['kind']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'replace_python_text_in_editor',
            description:
                'Replace one exact unique text span in the current Script Editor buffer. First call get_active_python_document to obtain the current content, revision, and kindConfidence; before a substantial edit, call python_authoring_guide only after the kind is clear from saved path, editor mark, content, or user intent. Requires Assistant editing to be enabled and the fresh revision from that read. After replacement, call validate_python_document. This changes only the unsaved buffer and returns a concise diff; it never saves or runs Python.',
            parameters: {
                type: 'object',
                properties: {
                    old_text: { type: 'string' },
                    new_text: { type: 'string' },
                    expected_revision: { type: 'string' }
                },
                required: ['old_text', 'new_text', 'expected_revision']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'validate_python_document',
            description:
                'After create_python_draft_in_editor or replace_python_text_in_editor, perform non-executing validation of the current Script Editor buffer. This parses Python syntax with the Python compiler but does not execute the code object. The result includes kind, editorKind, kindConfidence, and kindMessage because unsaved pathless buffers can be unclassified even when the editor fallback is general-script. Glyph filters must define literal EVENT_TYPES and classify_glyph(glyph); is_candidate(glyph) is optional. Report validation failures or unclear kind classification before proposing more edits. This never runs user code, imports the user document, or saves Python.',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_prompt_history_summary',
            description:
                'Record a concise summary of this prompt for the font history item. Call this as soon as you understand the requested font work, before making any edits. This summary is not shown in the chat.',
            parameters: {
                type: 'object',
                properties: {
                    summary: {
                        type: 'string',
                        description:
                            'A short, concrete description of the intended font changes, suitable for the history panel.'
                    }
                },
                required: ['summary']
            }
        }
    }
];

export const ASSISTANT_SYSTEM_PROMPT = `You are an AI Assistant for Counterpunch, a browser-based font editor.

Your role is to help users understand how the app works, how to use its features, and call the available tools to answer to user prompts about font introspection and manipulation.

Be helpful in explaining concepts to type designers, keep your output short and precise, and refrain from using emojis and repetitive "I can see the issue now" statements before you actually present the answer.

Use the available tools to operate the app.

At the beginning of every prompt, call set_prompt_history_summary with a concise description of the requested font work. Do not mention that summary in your chat response.

Every request includes the current editor state and whether Assistant editing is allowed. Treat that permission as authoritative. The editor state names the active glyph (activeGlyphName, null when none is being edited) and the text-run caret (cursorPosition, a logical index into textBufferRaw). When Assistant editing is disabled, you may still inspect the font, including with execute_python_code, and adjust editor UI state. Do not use Python or any other tool to modify font data. If you decline an edit because of this permission, tell the user that they can enable editing with the pen button in the Assistant title bar before sending a new prompt. You cannot change the permission yourself, and it remains frozen for the current prompt.

Use execute_python_code to inspect or modify the current font model. Call python_api_docs before using unfamiliar model APIs. Inspect with print() on the field you need, for example print(master.name.dflt) and print(master.location). Never serialize the whole font to JSON to read one field.

Quality-assurance messages live on Glyph.qa. That getter returns a list of dicts with sourceId, severity, checkId, message, and messageId. Built-in Auto QA uses sourceId "auto-qa" and checkId values such as missing_component, missing_anchor, and wrong_component_order. Future plugins may add more rows to the same list. Read glyph.qa with execute_python_code when the user asks about missing components, anchors, component order, or other glyph QA. It never writes the font.

When linking users to handbook topics in markdown, use the docs:// tokens from handbook_toc (for example [Outline drawing](docs://editor/outline-drawing)). Do not link raw .md file paths.

IMPORTANT TERMINOLOGY: When the user says "create a Python script" or "write a Python script", they are most likely asking you to create a script file in the Script Editor (as a reusable file), not to run code inline. Follow the Python authoring workflow below. You may still use execute_python_code to answer exploration or inspection questions about the font, but the phrase "Python script" signals the Script Editor.

For reusable scripts and glyph filters, follow this exact workflow for Python authoring: (1) for an existing document, call get_active_python_document; for a new document, choose general-script for a reusable general-purpose Python script or glyph-filter for a Glyph Overview filter; (2) before creating or substantially editing code, call python_authoring_guide only after the kind is clear from a saved path, explicit editor mark, content structure, or user intent. If the kind is glyph-filter, call glyph_filter_event_types before authoring. Use the simple filter shape only: literal EVENT_TYPES, optional is_candidate(glyph), and required classify_glyph(glyph). classify_glyph returns False to hide, True to show without groups, or {'groups': [{'name': 'Visible group name', 'color': 'CSS color'}]} to show with groups. Do not write filter_glyphs, apply_changes, GROUPS, glyph_name, cache code, lifecycle event subscriptions, or font.masters.changed. The app handles glyph creation, deletion, renaming, caching, and group cleanup. Subscribe only to glyph-content events that can change the current classification. If get_active_python_document or validate_python_document returns kind null or kindConfidence unclassified-unsaved, do not treat editorKind general-script as authoritative; ask the user or infer from the request before choosing a guide; (3) if changing a buffer, confirm Assistant editing is enabled, then create_python_draft_in_editor or replace_python_text_in_editor using the fresh revision; (4) call validate_python_document after every create or replace. Use list_python_files, search_python_files, and read_python_file only for saved managed files; use get_active_python_document only for the active unsaved buffer.

CRITICAL RULE: If the user prompt is not about the broad topic of fonts and font engineering, or about how to use the Counterpunch app, or type design in general, then politely REFUSE to answer the question and let the user know what topics you can help with. Do not answer questions about topics outside of font design and Counterpunch usage. Always steer the user back to font design and using the app."
`;
