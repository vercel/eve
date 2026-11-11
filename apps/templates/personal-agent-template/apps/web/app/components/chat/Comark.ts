import components from "@comark/nuxt/plugins/components";
import highlight from "@comark/nuxt/plugins/highlight";
import linkify from "@comark/nuxt/plugins/linkify";
import security from "@comark/nuxt/plugins/security";
import taskList from "@comark/nuxt/plugins/task-list";
import html from "@shikijs/langs/html";
import css from "@shikijs/langs/css";
import python from "@shikijs/langs/python";
import sql from "@shikijs/langs/sql";
import go from "@shikijs/langs/go";
import rust from "@shikijs/langs/rust";
import java from "@shikijs/langs/java";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import ruby from "@shikijs/langs/ruby";
import php from "@shikijs/langs/php";
import swift from "@shikijs/langs/swift";
import kotlin from "@shikijs/langs/kotlin";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import xml from "@shikijs/langs/xml";
import toml from "@shikijs/langs/toml";
import graphql from "@shikijs/langs/graphql";
import SourceLink from "./SourceLink.vue";

export default defineMarkdownComponent({
  name: "ChatComark",
  registerDefaultPlugins: false,
  plugins: [
    linkify(),
    taskList(),
    components(),
    highlight({
      languages: [
        html,
        css,
        python,
        sql,
        go,
        rust,
        java,
        c,
        cpp,
        ruby,
        php,
        swift,
        kotlin,
        diff,
        dockerfile,
        xml,
        toml,
        graphql,
      ],
    }),
    security({
      allowedTags: [
        "p",
        "br",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "li",
        "strong",
        "em",
        "del",
        "a",
        "img",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "pre",
        "code",
        "span",
        "input",
        "source-link",
      ],
      allowedProtocols: ["https", "http", "mailto"],
      allowDataImages: false,
    }),
  ],
  components: {
    "source-link": SourceLink,
  },
  class: "*:first:mt-0 *:last:mb-0",
});
