import { LanguageDescription, LanguageSupport, StreamLanguage, type StringStream } from "@codemirror/language";

/**
 * Smali (Dalvik assembly, what apktool decodes classes.dex into) for the
 * editor: directives, opcodes, registers, type descriptors, strings, numbers
 * and comments, colored with the same `--studio-syntax-*` tokens as other code.
 */
const smali = StreamLanguage.define<{ afterOpcode: boolean }>({
  name: "smali",
  startState: () => ({ afterOpcode: false }),
  token(stream: StringStream, state) {
    if (stream.sol()) state.afterOpcode = false;
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
    // .class, .method, .field, .end method, .line, .locals …
    if (stream.match(/^\.[a-z][\w-]*/)) {
      state.afterOpcode = true;
      return "keyword";
    }
    // Labels (:cond_0, :goto_1).
    if (stream.match(/^:[\w$]+/)) {
      state.afterOpcode = true;
      return "labelName";
    }
    // Registers v0, p1.
    if (stream.match(/^[vp]\d+\b/)) return "variableName";
    // Type descriptors: Lcom/example/Foo; and arrays of them, primitives after [.
    if (stream.match(/^\[*L[\w/$<>-]+;/)) return "typeName";
    if (stream.match(/^\[+[ZBSCIJFDV]/)) return "typeName";
    // Method and field references after ->.
    if (stream.match("->")) return "operator";
    if (stream.match(/^-?0x[\da-fA-F]+[LlSsTt]?/) || stream.match(/^-?\d+(?:\.\d+)?[LlSsTtFfDd]?/)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "atom";
    if (stream.match(/^(?:public|private|protected|static|final|synthetic|abstract|constructor|bridge|varargs|native|interface|enum|annotation|volatile|transient|declared-synchronized|system|build|runtime)\b/)) {
      return "modifier";
    }
    // The first word of an instruction line is the opcode (invoke-virtual, const-string …).
    if (!state.afterOpcode && stream.match(/^[a-z][\w/-]*/)) {
      state.afterOpcode = true;
      return "controlKeyword";
    }
    if (stream.match(/^[\w$<>]+(?=\()/)) return "variableName.function";
    if (stream.match(/^[{}(),=;[\]]/)) return "punctuation";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
});

export const smaliLanguageDescription = LanguageDescription.of({
  name: "Smali",
  extensions: ["smali"],
  load: async () => new LanguageSupport(smali),
});
