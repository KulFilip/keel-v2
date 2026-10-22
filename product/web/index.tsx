// keel Product's web part (a plugin): `npm run build:product` (in web/) builds this file on its own into
// product/web/dist (index.js, style.css). keel loads it at run time from the url /api/features gives, and only when
// Product is on. It imports only @keel/web-sdk and react: keel's page shares its own copies (the import map).

import { definePlugin } from "@keel/web-sdk";
import Initiatives from "./Initiatives";
import ProductMap from "./ProductMap";
import Teams from "./Teams";
import "./product.css";

export default definePlugin({
  name: "product",
  pages: {
    "product-map": ProductMap,
    initiatives: Initiatives,
    teams: Teams,
  },
});
