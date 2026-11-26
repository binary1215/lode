"""Isolated, parse-only Python source observer. Never imports project modules.

Reports lexical direct-name candidates, not dynamic Python call truth. Other
calls remain explicit unresolved observations. Input/output is one JSON frame.
"""
import ast
import hashlib
import io
import json
import sys
import tokenize

VERSION = "python-ast-direct-name-1"
MAX_FRAME = 12 * 1024 * 1024
MATCH_BINDINGS = tuple(getattr(ast, name) for name in ("MatchAs", "MatchStar") if hasattr(ast, name))
MAPPING_BINDINGS = tuple(getattr(ast, name) for name in ("MatchMapping",) if hasattr(ast, name))


def profile():
    with open(ast.__file__, "rb") as source:
        ast_digest = hashlib.sha256(source.read()).hexdigest()
    with open(tokenize.__file__, "rb") as source:
        tokenize_digest = hashlib.sha256(source.read()).hexdigest()
    return {"version": VERSION, "python": sys.version, "implementation": sys.implementation.name,
            "astDigest": ast_digest, "tokenizeDigest": tokenize_digest,
            "isolated": bool(sys.flags.isolated), "noSite": bool(sys.flags.no_site)}


def parse_source(item):
    text = item["text"]
    return (text.split("\n"), ast.parse(text, filename=item["path"], type_comments=True),
            list(tokenize.generate_tokens(io.StringIO(text).readline)))


def declarations(item):
    lines, tree, tokens = parse_source(item)

    def point(line, column):
        return {"line": line - 1, "character": len(lines[line - 1][:column].encode("utf-16-le")) // 2}

    def ast_point(line, byte):
        prefix = lines[line - 1].encode("utf-8")[:byte].decode("utf-8", "strict")
        return (line, len(prefix))

    starts = {token.start: i for i, token in enumerate(tokens)}
    decorators, level, first = [], 0, True
    for token in tokens:
        if token.type == tokenize.OP:
            if token.string == "@" and level == 0 and first:
                decorators.append(token.start)
            if token.string in "([{":
                level += 1
            elif token.string in ")]}":
                level -= 1
        if token.type == tokenize.NEWLINE:
            first = True
        elif token.type not in (tokenize.INDENT, tokenize.DEDENT, tokenize.NL, tokenize.COMMENT, tokenize.ENCODING):
            first = False

    inventory = []
    counts = {}

    def walk(node, scope="", parent_kind=None, conditional=False):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                qualified = (scope + "." if scope else "") + child.name
                kind = "class" if isinstance(child, ast.ClassDef) else ("async-" if isinstance(child, ast.AsyncFunctionDef) else "") + ("method" if parent_kind == "class" else "function")
                counts[qualified] = counts.get(qualified, 0) + 1
                inventory.append((child, qualified, kind, scope, counts[qualified], conditional))
                walk(child, qualified, "class" if isinstance(child, ast.ClassDef) else "function", conditional)
            else:
                # These are static occurrences, not assertions about activated code.
                walk(child, scope, parent_kind, conditional or hasattr(child, "body") or hasattr(child, "orelse"))

    walk(tree)

    def record(entry):
        node, qualified, kind, scope, occurrence, conditional = entry
        begin = ast_point(node.lineno, node.col_offset)
        end = ast_point(node.end_lineno, node.end_col_offset)
        start = begin
        if node.decorator_list:
            expression = node.decorator_list[0]
            expression_start = ast_point(expression.lineno, expression.col_offset)
            matches = [p for p in decorators if p <= expression_start and p[1] == begin[1]]
            if not matches:
                raise ValueError("decorator-start-missing")
            start = matches[-1]
        index = starts.get(begin)
        if index is None:
            raise ValueError("declaration-token-missing")
        depth, header_end, name_token = 0, None, None
        # A return annotation may itself be an unparenthesized lambda. Its ':'
        # is not the suite delimiter, even though tokenizer bracket depth is zero.
        returns = getattr(node, "returns", None)
        annotation_end = ast_point(returns.end_lineno, returns.end_col_offset) if returns is not None else begin
        for token in tokens[index:]:
            if name_token is None and token.type == tokenize.NAME and token.string not in ("class", "def", "async"):
                name_token = token
            if token.type == tokenize.OP:
                if token.string == ":" and depth == 0 and token.start >= annotation_end:
                    header_end = token.end
                    break
                if token.string in "([{":
                    depth += 1
                elif token.string in ")]}":
                    depth -= 1
        if header_end is None or name_token is None:
            raise ValueError("header-token-missing")
        return {"qualifiedName": qualified, "kind": kind, "scope": scope, "occurrence": occurrence,
                "conditional": conditional, "decorated": bool(node.decorator_list),
                "range": {"start": point(*start), "end": point(*end)},
                "headerRange": {"start": point(*begin), "end": point(*header_end)},
                "nameRange": {"start": point(*name_token.start), "end": point(*name_token.end)}}

    matching = inventory if item["kind"] == "declarations" else [e for e in inventory if e[1] == item["symbol"]]
    status = "ready"
    if item["kind"] == "selected-source":
        selection = item.get("selection")
        if selection is not None:
            if selection["path"] != item["path"] or selection["fileDigest"] != hashlib.sha256(item["text"].encode("utf-8")).hexdigest():
                matching, status = [], "stale-selection"
            else:
                matching = [e for e in matching if e[2] == selection["kind"] and e[4] == selection["occurrence"]
                            and e[1] == selection["qualifiedName"] and record(e)["range"] == selection["range"]]
                if not matching:
                    status = "selection-mismatch"
        if status == "ready" and len(matching) != 1:
            status = "ambiguous" if matching else "missing"
    omitted = max(0, len(matching) - 64)
    if status == "ready" and omitted:
        status = "partial"
    return {"path": item["path"], "symbol": item["symbol"], "kind": item["kind"],
            "status": status, "declarationProtocol": "python-static-declarations-1",
            "total": len(matching), "omitted": omitted, "declarations": [record(e) for e in matching[:64]]}


def observe(item):
    text = item["text"]
    # Python source coordinates use physical LF/CRLF, not Unicode separators,
    # vertical tab or form feed inside valid string literals.
    lines, tree, tokens = parse_source(item)

    def position(line, byte):
        prefix = lines[line - 1].encode("utf-8")[:byte].decode("utf-8", "strict")
        return {"line": line - 1, "character": len(prefix.encode("utf-16-le")) // 2}

    def span(node):
        return {"start": position(node.lineno, node.col_offset), "end": position(node.end_lineno, node.end_col_offset)}

    def endpoint(node):
        # tokenize positions are Unicode code points, unlike AST byte offsets.
        names = [token for token in tokens if token.type == tokenize.NAME and token.string == node.name
                 and token.start[0] == node.lineno and token.start[1] >= node.col_offset]
        if not names:
            raise ValueError("declaration-name-not-found")
        token = names[0]
        def token_pos(point):
            line, column = point
            return {"line": line - 1, "character": len(lines[line - 1][:column].encode("utf-16-le")) // 2}
        return {"name": node.name, "symbolKind": "function", "declarationRange": span(node),
                "selectionRange": {"start": token_pos(token.start), "end": token_pos(token.end)}}

    functions = {}
    scopes = {}

    def inventory(node, qualified="", enclosing=None):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                key = qualified + ("." if qualified else "") + child.name
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    functions.setdefault(key, []).append(child)
                    scopes[id(child)] = enclosing if not isinstance(node, ast.ClassDef) else None
                inventory(child, key, child)
            else:
                inventory(child, qualified, enclosing)

    inventory(tree)
    matches = functions.get(item["symbol"], [])
    if len(matches) != 1:
        return {"path": item["path"], "symbol": item["symbol"], "pairs": [], "unresolved": [],
                "reason": "symbol-missing-or-ambiguous", "availableSymbols": sorted(functions)}
    caller = matches[0]

    def scope_nodes(scope):
        # Do not confuse bodies of other functions/classes/lambdas with this scope.
        for child in ast.iter_child_nodes(scope):
            yield child
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                yield from scope_nodes(child)

    def bindings(scope):
        definitions, rebound = {}, set()
        for child in scope_nodes(scope):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                definitions.setdefault(child.name, []).append(child)
            elif isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
                rebound.add(child.id)
            elif isinstance(child, (ast.Import, ast.ImportFrom)):
                rebound.update(alias.asname or alias.name.split(".")[0] for alias in child.names)
            elif isinstance(child, ast.ClassDef):
                rebound.add(child.name)
            elif isinstance(child, (ast.Global, ast.Nonlocal)):
                rebound.update(child.names)
            elif isinstance(child, ast.ExceptHandler) and child.name:
                rebound.add(child.name)
            elif isinstance(child, MATCH_BINDINGS) and child.name:
                rebound.add(child.name)
            elif isinstance(child, MAPPING_BINDINGS) and child.rest:
                rebound.add(child.rest)
        if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = scope.args
            rebound.update(arg.arg for arg in args.posonlyargs + args.args + args.kwonlyargs)
            rebound.update(arg.arg for arg in [args.vararg, args.kwarg] if arg)
            rebound.update(parameter.name for parameter in getattr(scope, "type_params", []))
        return definitions, rebound

    local_defs, local_rebound = bindings(caller)
    module_defs, module_rebound = bindings(tree)
    nested = "." in item["symbol"]
    pairs, unresolved = [], []
    for call in (node for node in scope_nodes(caller) if isinstance(node, ast.Call)):
        callee = call.func
        target = None
        reason = "dynamic-or-attribute-call"
        if isinstance(callee, ast.Name):
            name = callee.id
            defs = local_defs.get(name, [])
            if name in local_rebound:
                reason = "local-shadowing-or-rebinding"
            elif len(defs) == 1 and not defs[0].decorator_list and defs[0] in caller.body and defs[0].end_lineno < call.lineno:
                target = defs[0]
            elif defs:
                reason = "ambiguous-or-decorated-local-definition"
            elif nested:
                reason = "enclosing-scope-not-resolved"
            elif name in module_rebound:
                reason = "module-shadowing-import-or-rebinding"
            elif len(module_defs.get(name, [])) == 1 and not module_defs[name][0].decorator_list and module_defs[name][0] in tree.body:
                target = module_defs[name][0]
            else:
                reason = "external-ambiguous-or-decorated-definition"
        if target:
            pairs.append({"from": endpoint(caller), "to": endpoint(target), "range": span(callee)})
        else:
            unresolved.append({"range": span(callee), "reason": reason})
    return {"path": item["path"], "symbol": item["symbol"], "pairs": pairs, "unresolved": unresolved,
            "reason": None if pairs else "no-supported-positive-direct-name-call"}


def main():
    frame = sys.stdin.buffer.read(MAX_FRAME + 1)
    if len(frame) > MAX_FRAME:
        raise ValueError("input-frame-limit")
    request = json.loads(frame)
    result = {"protocol": VERSION, "profile": profile()}
    if request["operation"] in ("collect", "declarations"):
        result["results"] = []
        for item in request["sources"]:
            try:
                result["results"].append(declarations(item) if request["operation"] == "declarations" else observe(item))
            except (SyntaxError, ValueError, RecursionError, tokenize.TokenError) as error:
                if request["operation"] == "declarations":
                    result["results"].append({"path": item["path"], "symbol": item["symbol"], "kind": item["kind"],
                                              "declarationProtocol": "python-static-declarations-1", "status": "parse-unsupported",
                                              "total": 0, "omitted": 0, "declarations": [], "errorType": type(error).__name__})
                    continue
                result["results"].append({"path": item["path"], "symbol": item["symbol"], "pairs": [],
                                          "unresolved": [], "reason": "parse-unsupported", "errorType": type(error).__name__})
    elif request["operation"] != "identity":
        raise ValueError("unknown-operation")
    encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 1024 * 1024:
        encoded = json.dumps({"protocol": VERSION, "profile": result["profile"], "reason": "output-frame-limit"}).encode()
    sys.stdout.buffer.write(encoded)


if __name__ == "__main__":
    main()
