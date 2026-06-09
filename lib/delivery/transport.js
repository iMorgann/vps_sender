"use strict";

function getTransport(config) {
  return config.transport === "relay"
    ? require("./relay-client").deliverViaRelay
    : require("./smtp-client").deliverEmail;
}

module.exports = { getTransport };
