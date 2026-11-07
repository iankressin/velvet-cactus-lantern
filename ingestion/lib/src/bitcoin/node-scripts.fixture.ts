// One address of each type and the scriptPubKey that Bitcoin Core's validateaddress gave for it.
export const nodeScripts = {
  p2pkh: {
    address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
    script: "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac",
  },
  p2sh: {
    address: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
    script: "a91423e522dfc6656a8fda3d47b4fa53f7585ac758cd87",
  },
  p2wpkh: {
    address: "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h",
    script: "0014dc6bf86354105de2fcd9868a2b0376d6731cb92f",
  },
  p2wsh: {
    address: "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97",
    script: "00204364063fac8829a931a752ecd9049e43425e2cebf83681876c556002bf389b00",
  },
  p2tr: {
    address: "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    script: "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
  },
};
