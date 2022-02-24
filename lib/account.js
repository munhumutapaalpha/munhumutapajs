import curve25519 from "../util/curve25519.js";
import curve25519_ from "../util/curve25519_.js";
import NxtAddress from "../util/nxtaddress.js";
import helpers from "./helpers";
import BigInteger from "jsbn";
import * as pako from "pako";
import cryptoJs from "crypto-js";
import hex from "crypto-js/enc-hex";

function rsConvert(address) {
  var addr = new NxtAddress();
  addr.set(address);
  return {
    account: addr.account_id(),
    accountRS: addr.toString(),
  };
}

function secretPhraseToPublicKey(secretPhrase, asByteArray) {
  var hash = helpers.hexStringToByteArray(
    helpers.simpleHash(secretPhrase, "hex")
  );
  var pubKey = curve25519.keygen(hash).p;
  if (asByteArray) {
    return pubKey;
  }
  return helpers.byteArrayToHexString(pubKey);
}

function publicKeyToAccountId(publicKey, numeric) {
  var arr = helpers.hexStringToByteArray(publicKey);
  var account = helpers.simpleHash(arr, "hex");

  var slice = helpers.hexStringToByteArray(account).slice(0, 8);
  var accountId = helpers.byteArrayToBigInteger(slice).toString();

  if (numeric) {
    return accountId;
  }
  var address = new NxtAddress();
  if (!address.set(accountId)) {
    return "";
  }
  return address.toString();
}

function secretPhraseToAccountId(secretPhrase, numeric) {
  var pubKey = secretPhraseToPublicKey(secretPhrase);
  return publicKeyToAccountId(pubKey, numeric);
}

function signTransactionBytes(data, secretPhrase) {
  var unsignedBytes = helpers.hexStringToByteArray(data);
  var sig = signBytes(unsignedBytes, secretPhrase);
  const VERSION_POSITION = 6
  const SIGNATURE_POSITION = 69;
  const SIGNATURE_POSITION_V2 = 45;

  var sigPos = 2 * (unsignedBytes[VERSION_POSITION] < 2 ? SIGNATURE_POSITION : SIGNATURE_POSITION_V2);
  var sigLen = 2 * 64;
  var signature = helpers.byteArrayToHexString(sig);
  var signed =
    data.substr(0, sigPos) + signature + data.substr(sigPos + sigLen);
  return signed;
}

function signBytes(message, secretPhrase) {
  var messageBytes = message;
  var secretPhraseBytes = helpers.stringToByteArray(secretPhrase);

  var digest = helpers.simpleHash(secretPhraseBytes);
  var s = curve25519.keygen(digest).s;
  var m = helpers.simpleHash(messageBytes);

  var mBuf = Buffer.from(m);
  var sBuf = Buffer.from(s);
  /** Old crypto lib code */
  //   var hash = crypto.createHash("sha256");
  //   hash.update(mBuf);
  //   hash.update(sBuf);
  //   var x = hash.digest();
  /** */

  let hash1 = cryptoJs.lib.WordArray.create(mBuf);
  let hash2 = cryptoJs.lib.WordArray.create(sBuf);
  var beforeBuffer = cryptoJs.SHA256(hash1.concat(hash2));
  var x = Buffer.from(beforeBuffer.toString(hex), "hex");

  var y = curve25519.keygen(x).p;
  /** Old crypto lib code */
  //   hash = crypto.createHash("sha256");
  //   var yBuf = Buffer.from(y);
  //   hash.update(mBuf);
  //   hash.update(yBuf);
  //   var h = helpers.hexStringToByteArray(hash.digest("hex"));
  /** */

  let hash3 = cryptoJs.lib.WordArray.create(mBuf);
  let hash4 = cryptoJs.lib.WordArray.create(Buffer.from(y));
  var h = helpers.hexStringToByteArray(
    cryptoJs.SHA256(hash3.concat(hash4)).toString(hex)
  );

  var v = curve25519.sign(h, x, s);
  return v.concat(h);
}

function verifyTransactionBytes(byteArray, requestType, data, publicKey) {
  byteArray = helpers.hexStringToByteArray(byteArray);

  var transaction = {};
  var pos = 0;
  transaction.chain = String(helpers.byteArrayToSignedInt32(byteArray, pos));
  pos += 4;
  transaction.type = byteArray[pos++];

  if (transaction.type >= 128) {
    transaction.type -= 256;
  }
  transaction.subtype = byteArray[pos++];
  transaction.version = byteArray[pos++];
  transaction.timestamp = String(
    helpers.byteArrayToSignedInt32(byteArray, pos)
  );
  pos += 4;
  transaction.deadline = String(helpers.byteArrayToSignedShort(byteArray, pos));
  pos += 2;
  if (transaction.version < 2) {
    transaction.publicKey = helpers.byteArrayToHexString(byteArray.slice(pos, pos + 32));
    pos += 32;
  } else {
    transaction.sender = String(helpers.byteArrayToBigInteger(byteArray, pos));
    pos += 8;
  }
  transaction.recipient = String(helpers.byteArrayToBigInteger(byteArray, pos));
  pos += 8;
  transaction.amountMTA = String(helpers.byteArrayToBigInteger(byteArray, pos));
  pos += 8;
  transaction.feeMTA = String(helpers.byteArrayToBigInteger(byteArray, pos));
  pos += 8;
  transaction.signature = byteArray.slice(pos, pos + 64);
  pos += 64;
  transaction.ecBlockHeight = String(
    helpers.byteArrayToSignedInt32(byteArray, pos)
  );
  pos += 4;
  transaction.ecBlockId = String(helpers.byteArrayToBigInteger(byteArray, pos));
  pos += 8;
  transaction.flags = String(helpers.byteArrayToSignedInt32(byteArray, pos));
  pos += 4;

  if (transaction.version < 2) {
    if (transaction.publicKey !== publicKey) {
      return false;
    }
  } else {
    var accountId = publicKeyToAccountId(publicKey, true);
    if (transaction.sender != accountId) {
      return false;
    }
  }
  if (data.deadline) {  // Only check deadline if it was provided
    if (Number(transaction.deadline) !== Number(data.deadline)) {
      return false;
    }
  }

  // Handle different prefix by ignoring everything before the first -
  if (
    !(
      (data.recipient === undefined || data.recipient == "") &&
      transaction.recipient == "0"
    )
  ) {
    var transaction_raddress = rsConvert(transaction.recipient)["accountRS"];
    var data_raddress = rsConvert(data.recipient)['accountRS'];
    if (
      transaction_raddress.substring(transaction_raddress.indexOf("-")) !==
      data_raddress.substring(data.recipient.indexOf("-"))
    ) {
      return false;
    }
  }

  if (
    Number(transaction.amountMTA) !== Number(data.amountMTA) &&
    !(requestType === "exchangeCoins" && transaction.amountMTA === "0")
  ) {
    return false;
  }

  // if ("referencedTransactionFullHash" in data) {
  //     if (transaction.referencedTransactionFullHash !== data.referencedTransactionFullHash) {
  //         return false;
  //     }
  // } else if (transaction.referencedTransactionFullHash && transaction.referencedTransactionFullHash !== "") {
  //     return false;
  // }

  //has empty attachment, so no attachmentVersion byte...
  if (!(requestType == "sendMoney" || requestType == "sendMessage")) {
    pos++;
  }

  //return NRS.verifyTransactionTypes(byteArray, transaction, requestType, data, pos, attachment); //Missing function to check transaction type
  return true;
}

function generateToken(message, secretPhrase, isTestnet) {
  var messageBytes = helpers.getUtf8Bytes(message);
  var pubKeyBytes = helpers.hexStringToByteArray(
    secretPhraseToPublicKey(secretPhrase)
  );
  var token = pubKeyBytes;

  var tsb = [];
  var ts = helpers.toEpochTime(undefined, isTestnet);
  tsb[0] = ts & 0xff;
  tsb[1] = (ts >> 8) & 0xff;
  tsb[2] = (ts >> 16) & 0xff;
  tsb[3] = (ts >> 24) & 0xff;

  messageBytes = messageBytes.concat(pubKeyBytes, tsb);
  token = token.concat(tsb, signBytes(messageBytes, secretPhrase));

  var buf = "";
  for (var ptr = 0; ptr < 100; ptr += 5) {
    var nbr = [];
    nbr[0] = token[ptr] & 0xff;
    nbr[1] = token[ptr + 1] & 0xff;
    nbr[2] = token[ptr + 2] & 0xff;
    nbr[3] = token[ptr + 3] & 0xff;
    nbr[4] = token[ptr + 4] & 0xff;
    var number = byteArrayToBigInteger(nbr);
    if (number < 32) {
      buf += "0000000";
    } else if (number < 1024) {
      buf += "000000";
    } else if (number < 32768) {
      buf += "00000";
    } else if (number < 1048576) {
      buf += "0000";
    } else if (number < 33554432) {
      buf += "000";
    } else if (number < 1073741824) {
      buf += "00";
    } else if (number < 34359738368) {
      buf += "0";
    }
    buf += number.toString(32);
  }
  return buf;
}

function decryptNote(message, options, secretPhrase) {
  options.privateKey = helpers.hexStringToByteArray(
    getPrivateKey(secretPhrase)
  );
  if (!options.publicKey) {
    options.publicKey = helpers.hexStringToByteArray(
      secretPhraseToPublicKey(secretPhrase)
    );
  } else {
    //Added for decypt message because if public key was provided, it was the hex string
    options.publicKey = helpers.hexStringToByteArray(options.publicKey);
  }
  if (options.nonce) {
    options.nonce = helpers.hexStringToByteArray(options.nonce);
  }
  return decryptData(helpers.hexStringToByteArray(message), options);
}

function encryptMessage(
  text,
  senderSecretPhrase,
  recipientPublicKey,
  isMessageToSelf
) {
  var encrypted = encryptNote(
    text,
    {
      publicKey: recipientPublicKey,
    },
    senderSecretPhrase
  );
  if (isMessageToSelf) {
    return {
      encryptToSelfMessageData: encrypted.message,
      encryptToSelfMessageNonce: encrypted.nonce,
      messageToEncryptToSelfIsText: "true",
    };
  } else {
    return {
      encryptedMessageData: encrypted.message,
      encryptedMessageNonce: encrypted.nonce,
      messageToEncryptIsText: "true",
    };
  }
}

function encryptNote(message, options, secretPhrase) {
  options.privateKey = helpers.hexStringToByteArray(
    getPrivateKey(secretPhrase)
  );
  if (!options.publicKey) {
    options.publicKey = helpers.hexStringToByteArray(
      secretPhraseToPublicKey(secretPhrase)
    );
  } else {
    //Added for encrypt message because if public key was provided, it was the hex string
    options.publicKey = helpers.hexStringToByteArray(options.publicKey);
  }

  let encrypted = encryptData(helpers.stringToByteArray(message), options);
  return {
    message: helpers.byteArrayToHexString(encrypted.data),
    nonce: helpers.byteArrayToHexString(encrypted.nonce),
  };
}

//Local Functions

function decryptData(data, options) {
  if (!options.sharedKey) {
    options.sharedKey = getSharedSecret(options.privateKey, options.publicKey);
  }

  var result = aesDecrypt(data, options);
  var binData = new Uint8Array(result.decrypted);
  if (!(options.isCompressed === false)) {
    binData = pako.inflate(binData);
  }
  var message;
  if (!(options.isText === false)) {
    message = helpers.byteArrayToString(binData);
  } else {
    message = helpers.byteArrayToHexString(binData);
  }
  return {
    message: message,
    sharedKey: helpers.byteArrayToHexString(result.sharedKey),
  };
}

function encryptData(plaintext, options) {
  options.nonce = getRandomBytes(32);
  if (!options.sharedKey) {
    options.sharedKey = getSharedSecret(options.privateKey, options.publicKey);
  }
  var compressedPlaintext = pako.gzip(new Uint8Array(plaintext));
  var data = aesEncrypt(compressedPlaintext, options);
  return {
    nonce: options.nonce,
    data: data,
  };
}

function getRandomBytes(length) {
  if (!window.crypto && !window.msCrypto && !crypto) {
    throw {
      errorCode: -1,
      message: $.t("error_encryption_browser_support"),
    };
  }
  var bytes = new Uint8Array(length);
  if (window.crypto) {
    //noinspection JSUnresolvedFunction
    window.crypto.getRandomValues(bytes);
  } else if (window.msCrypto) {
    //noinspection JSUnresolvedFunction
    window.msCrypto.getRandomValues(bytes);
  } else {
    bytes = cryptoJs.lib.WordArray.random(length);
    //bytes = crypto.randomBytes(length);
  }
  return bytes;
}

function getSharedSecret(key1, key2) {
  return helpers.shortArrayToByteArray(
    curve25519_(
      helpers.byteArrayToShortArray(key1),
      helpers.byteArrayToShortArray(key2),
      null
    )
  );
}

function aesDecrypt(ivCiphertext, options) {
  if (ivCiphertext.length < 16 || ivCiphertext.length % 16 != 0) {
    throw {
      name: "invalid ciphertext",
    };
  }

  var iv = helpers.byteArrayToWordArray(ivCiphertext.slice(0, 16));
  var ciphertext = helpers.byteArrayToWordArray(ivCiphertext.slice(16));

  // shared key is use for two different purposes here
  // (1) if nonce exists, shared key represents the shared secret between the private and public keys
  // (2) if nonce does not exists, shared key is the specific key needed for decryption already xored
  // with the nonce and hashed
  var sharedKey;
  if (!options.sharedKey) {
    sharedKey = getSharedSecret(options.privateKey, options.publicKey);
  } else {
    sharedKey = options.sharedKey.slice(0); //clone
  }

  var key;
  if (options.nonce) {
    for (var i = 0; i < 32; i++) {
      sharedKey[i] ^= options.nonce[i];
    }
    key = cryptoJs.SHA256(helpers.byteArrayToWordArray(sharedKey));
  } else {
    key = helpers.byteArrayToWordArray(sharedKey);
  }

  var encrypted = cryptoJs.lib.CipherParams.create({
    ciphertext: ciphertext,
    iv: iv,
    key: key,
  });

  var decrypted = cryptoJs.AES.decrypt(encrypted, key, {
    iv: iv,
  });

  return {
    decrypted: helpers.wordArrayToByteArray(decrypted, true),
    sharedKey: helpers.wordArrayToByteArray(key, true),
  };
}

function aesEncrypt(plaintext, options) {
  var ivBytes = getRandomBytes(16);

  // CryptoJS likes WordArray parameters
  var text = helpers.byteArrayToWordArray(plaintext);
  var sharedKey;
  if (!options.sharedKey) {
    sharedKey = getSharedSecret(options.privateKey, options.publicKey);
  } else {
    sharedKey = options.sharedKey.slice(0); //clone
  }
  for (var i = 0; i < 32; i++) {
    sharedKey[i] ^= options.nonce[i];
  }
  var key = cryptoJs.SHA256(helpers.byteArrayToWordArray(sharedKey));
  var encrypted = cryptoJs.AES.encrypt(text, key, {
    iv: helpers.byteArrayToWordArray(ivBytes),
  });
  var ivOut = helpers.wordArrayToByteArray(encrypted.iv, true);
  var ciphertextOut = helpers.wordArrayToByteArray(encrypted.ciphertext, true);
  return ivOut.concat(ciphertextOut);
}

function getPrivateKey(secretPhrase) {
  var bytes = helpers.simpleHash(helpers.stringToByteArray(secretPhrase));
  return helpers.shortArrayToHexString(
    curve25519_clamp(helpers.byteArrayToShortArray(bytes))
  );
}

function curve25519_clamp(curve) {
  curve[0] &= 0xfff8;
  curve[15] &= 0x7fff;
  curve[15] |= 0x4000;
  return curve;
}

function byteArrayToBigInteger(byteArray) {
  var value = new BigInteger("0", 10);
  for (var i = byteArray.length - 1; i >= 0; i--) {
    value = value
      .multiply(new BigInteger("256", 10))
      .add(new BigInteger(byteArray[i].toString(10), 10));
  }
  return value;
}

export default {
  rsConvert: rsConvert,
  secretPhraseToPublicKey: secretPhraseToPublicKey,
  publicKeyToAccountId: publicKeyToAccountId,
  secretPhraseToAccountId: secretPhraseToAccountId,
  signTransactionBytes: signTransactionBytes,
  signBytes: signBytes,
  verifyTransactionBytes: verifyTransactionBytes,
  generateToken: generateToken,
  decryptNote: decryptNote,
  encryptNote: encryptNote,
  encryptMessage: encryptMessage,
};
